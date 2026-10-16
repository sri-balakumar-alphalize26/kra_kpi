"use client";
/* One developer's day, opened from Live Tracking: /kpi_owner/employee_day.
   The same payload the End Workday summary is built from (read-only here),
   plus every start / end of the day, the first start (what attendance is
   judged on) and, for today, tasks still missing a progress note. Today
   refreshes every 15 s like the Odoo screen; a past day is fetched once.
   The route never opens a session, so looking does not start anyone's day. */
import { useState } from "react";
import { Button, IconButton, Lozenge, Modal, Skeleton } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import * as A from "@/lib/services/admin";

const AWAY = [["break", "Break"], ["lunch", "Lunch"], ["meeting", "Meeting"], ["no_tasks", "No tasks"], ["other", "Other"], ["away", "Away (system)"], ["other_idle", "Other / Idle"]];
const OUTCOME = { completed: "✓ Completed", submitted: "◑ Verification pending", paused: "⏸ Paused", active: "▶ In progress", moved: "↪ Moved", worked: "Worked" };
const hhmm = (ts) => (ts ? String(ts).slice(11, 16) || ts : "—");
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default function EmployeeDay({ person, onClose, onOpenTask }) {
  const today = ymd(new Date());
  const [date, setDate] = useState(today);
  const isToday = date === today;
  const day = useResource(A.EMPLOYEE_DAY_PATH, A.employeeDayParams(person.user_id, isToday ? null : date), { pollMs: isToday ? 15000 : 0, ttl: isToday ? 5000 : 60000 });
  const d = day.data;
  const refused = d && d.status === false;
  const shift = (n) => { const x = new Date(date + "T00:00:00"); x.setDate(x.getDate() + n); const v = ymd(x); if (v <= today) setDate(v); };
  const label = new Date(date + "T00:00:00").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });

  return (
    <Modal open onClose={onClose} width={820}
      title={<span style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ flex: 1, minWidth: 0 }}>{person.name}<small className="mini" style={{ display: "block", fontWeight: 600 }}>
          {!d || refused ? label : d.started === false ? `No workday on ${label}` : d.logout_at ? `Day ended · ${label}` : isToday ? "Today so far · updates every 15 s" : label}
        </small></span>
        <span className="input" style={{ height: 32, fontSize: 13 }}>
          <IconButton icon="cleft" label="Previous day" size={14} onClick={() => shift(-1)} />
          <input type="date" value={date} max={today} onChange={(e) => { if (e.target.value && e.target.value <= today) setDate(e.target.value); }} aria-label="Day" style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit" }} />
          <IconButton icon="cright" label="Next day" size={14} onClick={() => shift(1)} disabled={isToday} />
        </span>
        {!isToday && <Button size="sm" kind="ghost" onClick={() => setDate(today)}>Today</Button>}
      </span>}
      footer={<><Button kind="ghost" icon="swap" busy={day.loading} onClick={day.refresh}>Refresh</Button><Button onClick={onClose}>Close</Button></>}>
      {day.error && !d && <div className="callout danger">{day.error.message}</div>}
      {refused && <div className="callout danger">{d.message || "Could not load that day."}</div>}
      {!d && !day.error && <Skeleton rows={6} />}
      {d && !refused && d.started === false && <div className="callout info">{person.name} {isToday ? "has not started a workday today." : `had no workday on ${label}.`}</div>}
      {d && !refused && d.started !== false && <DaySummary d={d} onOpenTask={onOpenTask} />}
    </Modal>
  );
}

function DaySummary({ d, onOpenTask }) {
  const away = AWAY.filter(([k]) => (d[`${k}_seconds`] || 0) > 0);
  const tasks = d.tasks || [];
  const multi = d.allow_multitask || tasks.some((t) => t.concurrent);
  const sessions = d.sessions || [];
  const open = (id) => (e) => { if (!onOpenTask) return; e.preventDefault(); onOpenTask(id); };
  return (
    <div className="ewd">
      {d.auto_closed && <div className="callout warn">Auto-closed by the system.</div>}

      {(d.missing_progress || []).length > 0 && (
        <section className="ewd-box warn">
          <h3>{d.missing_progress.length} task{d.missing_progress.length === 1 ? "" : "s"} worked today {d.missing_progress.length === 1 ? "has" : "have"} no progress update</h3>
          {d.missing_progress.map((m) => <div key={m.kpi_id} className="mini" style={{ color: "var(--text)" }}><span className="ref">{m.external_ref || `#${m.kpi_id}`}</span> {m.name}</div>)}
        </section>
      )}

      <div className="ewd-stats">
        <div className="stat"><small>Login</small><b>{hhmm(d.login_at)}</b><span>{d.session_date || ""}</span></div>
        <div className="stat"><small>Productive</small><b style={{ color: "var(--pri-regular)" }}>{d.productive_display || "0h 0m"}</b><span>task time</span></div>
        <div className="stat"><small>Presence</small><b style={{ color: d.met_standard ? "var(--pri-regular)" : "var(--danger)" }}>{d.presence_display || "0h 0m"}</b><span>{d.met_standard ? "✓" : "▾"} {d.standard_display} standard</span></div>
        <div className="stat"><small>Accounted</small><b>{d.accounted_display || "0h 0m"}</b><span>task + meeting + lunch + break + no-tasks + paused</span></div>
        {(d.paused_seconds || 0) > 0 && <div className="stat"><small>Workday paused</small><b>{d.paused_display}</b><span>paused time</span></div>}
      </div>

      {sessions.length > 0 && (
        <section className="ewd-box">
          <h3>Start / end log <Lozenge tone={d.late ? "paused" : "done"} style={{ marginLeft: 6 }}>First start {d.first_login || "—"} · {d.late ? "Late" : "On time"}</Lozenge></h3>
          <table className="table">
            <tbody>
              {sessions.map((x) => (
                <tr key={x.n}>
                  <td className="mini" style={{ width: 24 }}>{x.n}</td>
                  <td style={{ whiteSpace: "normal" }}>
                    <b>{x.login} → {x.open ? "now" : (x.logout || "—")}</b><span className="mini"> · {x.duration_display}</span>
                    {x.reopened && <div className="mini" style={{ color: "var(--lz-paused)" }}>↩ Reopened {x.reopened_at}{x.reopened_by ? ` by ${x.reopened_by}` : ""}{x.reopen_reason ? ` — ${x.reopen_reason}` : ""}</div>}
                  </td>
                  <td className="num">{x.open ? <Lozenge tone="progress">● Open</Lozenge> : x.auto_closed ? <Lozenge tone="paused">Auto-closed</Lozenge> : <Lozenge tone="todo">Ended</Lozenge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="ewd-box">
        <h3>Away time <span className="mini">(inside Presence — never Productive)</span></h3>
        {away.length ? <div className="ewd-away">{away.map(([k, l]) => <span key={k} className="ewd-tag"><b>{d[`${k}_display`]}</b>{l}</span>)}</div> : <span className="mini">No away time.</span>}
        {(d.away_events || []).length > 0 && (
          <ul className="ewd-events">
            {d.away_events.map((e, i) => (
              <li key={i}><span className="ewd-tag sm">{e.label}</span>{e.start} – {e.end} ({e.duration_display}){e.from ? ` · from "${e.from}"` : ""}{e.with ? ` · with ${e.with}` : ""}{e.note ? ` — ${e.note}` : ""}</li>
            ))}
          </ul>
        )}
      </section>

      {(d.timeline || []).length > 0 && (
        <section className="ewd-box">
          <h3>Workday map <span className="mini">({d.dev || "their"} day in order)</span></h3>
          <div className="ewd-map">
            {d.timeline.map((n, i) => (
              <span key={i} className="ewd-step">
                {i > 0 && <i className="ewd-arrow">→</i>}
                <span className={`ewd-chip k-${n.kind}`}>
                  <b>{n.kind === "task" ? `${n.ref ? `${n.ref} ` : ""}${n.name || n.label}` : n.label}</b>
                  <small>
                    {n.time}{n.duration_display ? ` · ${n.duration_display}` : ""}{n.kind === "task" && OUTCOME[n.outcome] ? ` · ${OUTCOME[n.outcome]}` : ""}{n.running ? " · running" : ""}
                    {n.with ? ` · with ${n.with}` : ""}{n.reason ? ` · ${n.reason}` : ""}
                  </small>
                </span>
              </span>
            ))}
          </div>
        </section>
      )}

      <section className="ewd-box">
        <h3>Tasks worked ({d.task_count ?? tasks.length})</h3>
        {tasks.length ? (
          <table className="table">
            <thead><tr><th>Ref</th><th>Task</th><th className="num">Time</th></tr></thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.kpi_id} style={t.concurrent ? { boxShadow: "inset 3px 0 0 var(--pri-important)" } : undefined}>
                  <td><span className="ref">{t.ref || `#${t.kpi_id}`}</span></td>
                  <td style={{ whiteSpace: "normal" }}>{t.concurrent ? "⚡ " : ""}<a href={`/board?task=${t.kpi_id}`} onClick={open(t.kpi_id)}>{t.name}</a>{t.concurrent && <small className="mini" style={{ display: "block" }}>{t.solo_display} alone · {t.shared_display} shared</small>}</td>
                  <td className="num">{t.duration_display}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <span className="mini">No task time logged.</span>}
        {multi && <p className="mini" style={{ margin: "6px 0 0" }}>⚡ ran at the same time as another task.</p>}
      </section>
    </div>
  );
}
