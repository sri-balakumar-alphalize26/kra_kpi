"use client";
/* The Dashboard's employee popup: one person, four tabs.
     header    who, what they are doing right now (the live row the page
               already polls), call / WhatsApp, Nudge, Reopen workday
     Overview  the day and the workload in numbers, and their contact card
     Today     today's summary: stats, start/end log, away time, Workday map,
               tasks worked (EmployeeDay's DaySummary, refreshed every 15 s)
     Workload  every open task, what they finished, deadlines, questions they
               are waiting on, today's meetings
     History   any earlier day (same summary) and the last 30 days' attendance
   Data: the live row, /kpi_owner/employee_profile (once per open) and
   /kpi_owner/employee_day (Today / History, only while that tab is shown).
   Read-only apart from Nudge and Reopen, which are Live Tracking's actions. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Avatar, Button, Lozenge, Modal, Skeleton, Tabs, useDialogs, useFlags } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import * as A from "@/lib/services/admin";
import { DaySummary } from "./EmployeeDay";
import { ST, TS, cardText, clock, hm, since, statusOf } from "./employeeStatus";

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dmy = (s, o = { day: "numeric", month: "short" }) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", o) : "");
const TONE = { running: "progress", paused: "paused", todo: "todo", hold: "danger", approval: "review", done: "done" };

export default function EmployeePopup({ person: p, onClose, onChanged }) {
  const flags = useFlags();
  const dlg = useDialogs();
  const [tab, setTab] = useState("overview");
  const [prof, setProf] = useState(null);
  const [profErr, setProfErr] = useState("");
  const [busy, setBusy] = useState("");
  const [asking, setAsking] = useState(false); /* a dialog is open: Escape belongs to it */

  const loadProfile = () => A.fetchEmployeeProfile(p.user_id)
    .then((r) => { if (r?.status === false) setProfErr(r.message || "Could not load."); else { setProf(r); setProfErr(""); } })
    .catch((e) => setProfErr(e.message));
  useEffect(() => { loadProfile(); }, [p.user_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const s = statusOf(p);
  const [line, sub] = cardText(p, s);
  const c = prof?.contact;

  const nudge = async () => {
    setAsking(true);
    const v = await dlg.form({ title: `Nudge ${p.name}`, text: p.started ? "They get a notification that you are checking in." : "They get a notification asking them to start their workday.", fields: [{ key: "note", label: "Note (optional)", value: "", required: false }], confirmLabel: "Send nudge" });
    setAsking(false);
    if (!v) return;
    setBusy("nudge");
    try { A.assertOk(await A.nudgeUser(p.user_id, v.note), "Could not nudge."); flags.ok(`Nudged ${p.name}.`); }
    catch (e) { flags.err(e.message); } finally { setBusy(""); }
  };
  const reopen = async () => {
    setAsking(true);
    const v = await dlg.form({ title: `Reopen ${p.name}'s workday`, text: "Their day was ended. Reopening lets them continue today; the reason is recorded.", fields: [{ key: "reason", label: "Reason", value: "" }], confirmLabel: "Reopen" });
    setAsking(false);
    if (!v) return;
    setBusy("reopen");
    try { A.assertOk(await A.revertWorkday(p.user_id, v.reason), "Could not reopen."); flags.ok(`${p.name}'s workday reopened.`); onChanged?.(); }
    catch (e) { flags.err(e.message); } finally { setBusy(""); }
  };

  return (
    <Modal open onClose={() => { if (!asking) onClose(); }} width={920}
      title={<span className="ep-title">{p.name}<small>{c?.role || p.role || "Developer"} · {since(p)}</small></span>}
      footer={<Button onClick={onClose}>Close</Button>}>
      <div className="ep">
        {/* ---- header: right now ---- */}
        <div className={`ep-head s-${s}`}>
          <span className="d3-av"><Avatar name={p.name} uid={p.user_id} size={48} /><i /></span>
          <div className="ep-now">
            <span className="d3-badge">{ST[s]}</span>
            <b>{line}</b>{sub && <small>{sub}</small>}
            {p.activity_note && s === "working" && <small>“{p.activity_note}”</small>}
            {(p.active_tasks || []).length > 1 && <small>{p.active_tasks.length} tasks running at once</small>}
            {p.reopened_reason && <small className="ep-warn">↩ Reopened{p.reopened_by ? ` by ${p.reopened_by}` : ""} — {p.reopened_reason}</small>}
          </div>
          <div className="ep-acts">
            {c?.mobile && <a className="btn btn-ghost" href={`tel:+${c.dial}${c.mobile}`} title={`Call +${c.dial} ${c.mobile}`}>📞 Call</a>}
            {c?.whatsapp && <a className="btn btn-ghost" href={`https://wa.me/${c.whatsapp}`} target="_blank" rel="noopener noreferrer" title={`WhatsApp +${c.whatsapp}`}>💬 WhatsApp</a>}
            <Button busy={busy === "nudge"} onClick={nudge}>Nudge</Button>
            {p.day_done && <Button kind="primary" busy={busy === "reopen"} onClick={reopen}>Reopen workday</Button>}
          </div>
        </div>

        <Tabs items={[{ key: "overview", label: "Overview" }, { key: "today", label: "Today" }, { key: "workload", label: "Workload", count: prof?.workload?.open }, { key: "history", label: "History" }]} value={tab} onChange={setTab} />

        {profErr && (tab === "overview" || tab === "workload") && <div className="callout danger">{profErr}</div>}
        {tab === "overview" && <Overview p={p} prof={prof} />}
        {tab === "today" && <Day userId={p.user_id} name={p.name} />}
        {tab === "workload" && <Workload prof={prof} />}
        {tab === "history" && <History p={p} prof={prof} />}
      </div>
    </Modal>
  );
}

/* ---------------- Overview ---------------- */
function Overview({ p, prof }) {
  if (!prof) return <Skeleton rows={6} />;
  const w = prof.workload, c = prof.contact, att = prof.attendance?.totals || {};
  const pct = Math.min(100, ((p.productive_today || 0) / (8 * 3600)) * 100);
  return (
    <div className="ep-grid">
      <div className="d3-tiles">
        <div className="d3-tile"><div className="t">Productive today</div><div className="v">{hm(p.productive_today)}</div><div className="d3-bar"><i style={{ width: `${pct}%` }} /></div><div className="n" style={{ marginTop: 4 }}>of an 8-hour day</div></div>
        <div className="d3-tile"><div className="t">Done</div><div className="v d3-ok">{w.done_week}</div><div className="n">this week · {w.done_today} today · {w.done_month} this month</div></div>
        <div className="d3-tile"><div className="t">Open tasks</div><div className="v">{w.open}</div><div className="n">{w.counts.running} running · {w.counts.paused} paused · {w.counts.todo} to do · {w.counts.approval} approval</div></div>
        <div className="d3-tile"><div className="t">Deadlines</div><div className={`v ${w.overdue ? "d3-bad" : ""}`}>{w.overdue}</div><div className={`n ${w.overdue ? "d3-bad" : ""}`}>overdue · {w.due_week} due this week</div></div>
        <div className="d3-tile"><div className="t">Estimate vs spent</div><div className={`v ${w.spent_total > w.est_total && w.est_total ? "d3-bad" : ""}`}>{w.spent_total}h <small>/ {w.est_total}h</small></div><div className="n">on open tasks</div></div>
        <div className="d3-tile"><div className="t">Attendance · 30 days</div><div className="v">{att.on_time || 0}<small> on time</small></div><div className="n">{att.late || 0} late · {att.absent || 0} absent</div></div>
      </div>
      <section className="ep-box">
        <h3>Contact & login</h3>
        <dl className="ep-dl">
          <dt>Login mobile</dt><dd>{c.mobile ? `+${c.dial} ${c.mobile}` : "—"}{c.country ? ` · ${c.country}` : ""}</dd>
          <dt>WhatsApp</dt><dd>{c.whatsapp ? `+${c.whatsapp}` : <span className="d3-bad">no number — they can't be messaged</span>}</dd>
          <dt>App login</dt><dd>{c.app_login_enabled ? "On" : <span className="d3-bad">Off</span>}{c.pin_default ? " · PIN still the default 1111" : ""}</dd>
          <dt>Last sign-in</dt><dd>{c.last_app_login ? `${c.last_app_login}${c.last_device ? ` · ${c.last_device}` : ""}` : "never"}</dd>
          <dt>Odoo login</dt><dd>{c.login}</dd>
          <dt>Multitask</dt><dd>{c.allow_multitask ? "May run several tasks at once" : "One task at a time"}</dd>
        </dl>
      </section>
      {(prof.questions.length > 0 || prof.meetings_today.length > 0) && (
        <section className="ep-box">
          <h3>Waiting on</h3>
          {prof.questions.length > 0 && <p className="mini" style={{ margin: 0 }}>{prof.questions.length} question{prof.questions.length === 1 ? "" : "s"} to a manager, oldest {Math.max(...prof.questions.map((q) => q.days))} day(s)</p>}
          {prof.meetings_today.map((m) => <p key={m.id} className="mini" style={{ margin: "4px 0 0" }}>📅 {m.time} {m.name} · {m.state}</p>)}
        </section>
      )}
    </div>
  );
}

/* ---------------- Today / any day ---------------- */
function Day({ userId, name, date }) {
  const isToday = !date;
  const day = useResource(A.EMPLOYEE_DAY_PATH, A.employeeDayParams(userId, date || null), { pollMs: isToday ? 15000 : 0, ttl: isToday ? 5000 : 60000 });
  const d = day.data;
  if (day.error && !d) return <div className="callout danger">{day.error.message}</div>;
  if (!d) return <Skeleton rows={6} />;
  if (d.status === false) return <div className="callout danger">{d.message || "Could not load that day."}</div>;
  if (d.started === false) return <div className="callout info">{name} {isToday ? "has not started a workday today." : `had no workday on ${dmy(date, { weekday: "short", day: "numeric", month: "short" })}.`}</div>;
  return (
    <>
      {isToday && <p className="mini" style={{ margin: "0 0 8px" }}>Today so far · updates every 15 s</p>}
      <DaySummary d={d} onOpenTask={(id) => { location.href = `/board?task=${id}`; }} />
    </>
  );
}

/* ---------------- Workload ---------------- */
function Workload({ prof }) {
  if (!prof) return <Skeleton rows={6} />;
  const w = prof.workload;
  return (
    <div className="ep-grid">
      <div className="ep-chips">
        {["running", "paused", "todo", "hold", "approval"].map((k) => <Lozenge key={k} tone={TONE[k]} style={{ textTransform: "none" }}>{TS[k]} {w.counts[k] || 0}</Lozenge>)}
        <Lozenge tone="done" style={{ textTransform: "none" }}>Done {w.done_today} today · {w.done_week} week · {w.done_month} month</Lozenge>
        {w.overdue > 0 && <Lozenge tone="danger" style={{ textTransform: "none" }}>{w.overdue} overdue</Lozenge>}
        {w.due_week > 0 && <Lozenge tone="paused" style={{ textTransform: "none" }}>{w.due_week} due this week</Lozenge>}
      </div>
      <section className="ep-box">
        <h3>Open tasks ({w.open})</h3>
        {w.tasks.length ? (
          <div className="table-scroll" style={{ maxHeight: 340 }}>
            <table className="table">
              <thead><tr><th>Ref</th><th>Task</th><th>Client</th><th>State</th><th>Deadline</th><th className="num">Spent / est.</th></tr></thead>
              <tbody>
                {w.tasks.map((t) => (
                  <tr key={t.id}>
                    <td><span className="ref">{t.ref || `#${t.id}`}</span></td>
                    <td style={{ whiteSpace: "normal" }}><Link href={`/board?task=${t.id}`}>{t.name}</Link></td>
                    <td className="mini">{t.client || "—"}</td>
                    <td><Lozenge tone={TONE[t.state]} style={{ textTransform: "none" }} title={t.state_label}>{TS[t.state]}</Lozenge></td>
                    <td className={t.overdue ? "d3-bad" : t.due_week ? "" : "mini"}>{t.deadline ? dmy(t.deadline) : "—"}{t.overdue ? " · overdue" : ""}</td>
                    <td className={`num ${t.estimate_h && t.spent_h > t.estimate_h ? "d3-bad" : ""}`}>{t.spent_h}h / {t.estimate_h || "—"}{t.estimate_h ? "h" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <span className="mini">No open tasks.</span>}
      </section>
      <section className="ep-box">
        <h3>Questions waiting on a manager ({prof.questions.length})</h3>
        {prof.questions.length ? prof.questions.map((q) => (
          <div key={q.id} className="ep-q"><span className="ref">{q.ref || "—"}</span> <span>{q.question}</span> <span className="mini">· {q.days ? `${q.days} day${q.days === 1 ? "" : "s"}` : "today"}</span></div>
        )) : <span className="mini">None.</span>}
      </section>
      <section className="ep-box">
        <h3>Meetings today ({prof.meetings_today.length})</h3>
        {prof.meetings_today.length ? prof.meetings_today.map((m) => (
          <div key={m.id} className="ep-q"><b>{m.time}</b> {m.name} <span className="mini">· {m.state}</span>{m.join_url && <> · <a href={m.join_url} target="_blank" rel="noopener noreferrer">Join</a></>}</div>
        )) : <span className="mini">None.</span>}
      </section>
    </div>
  );
}

/* ---------------- History ---------------- */
const ATT = { on_time: "On time", late: "Late", absent: "Absent", off: "Sunday", pending: "Not yet" };
function History({ p, prof }) {
  const y = new Date(); y.setDate(y.getDate() - 1);
  const [date, setDate] = useState(ymd(y));
  const today = ymd(new Date());
  const att = prof?.attendance;
  return (
    <div className="ep-grid">
      <section className="ep-box">
        <h3>Attendance · last 30 days {att && <span className="mini">(late after {clock(att.cutoff)})</span>}</h3>
        {!att ? <Skeleton rows={2} /> : (
          <>
            <div className="ep-att" role="list">
              {att.days.map((d) => (
                <button key={d.date} type="button" role="listitem" className={`ep-day a-${d.status} ${d.date === date ? "on" : ""}`}
                  title={`${dmy(d.date, { weekday: "short", day: "numeric", month: "short" })} · ${ATT[d.status]}${d.first_login ? ` · in ${clock(d.first_login)}` : ""}`}
                  onClick={() => d.date < today && setDate(d.date)} disabled={d.date >= today}>
                  <span>{new Date(`${d.date}T00:00:00`).getDate()}</span>
                </button>
              ))}
            </div>
            <div className="ep-chips" style={{ marginTop: 8 }}>
              <Lozenge tone="done" style={{ textTransform: "none" }}>On time {att.totals.on_time}</Lozenge>
              <Lozenge tone="paused" style={{ textTransform: "none" }}>Late {att.totals.late}</Lozenge>
              <Lozenge tone="danger" style={{ textTransform: "none" }}>Absent {att.totals.absent}</Lozenge>
              <span className="mini">Click a day to see it below · <Link href="/reports/snapshots">Workday snapshots</Link></span>
            </div>
          </>
        )}
      </section>
      <section className="ep-box">
        <h3 style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {dmy(date, { weekday: "long", day: "numeric", month: "long" })}
          <input type="date" value={date} max={ymd(new Date(Date.now() - 864e5))} onChange={(e) => e.target.value && e.target.value < today && setDate(e.target.value)} aria-label="Day" className="ep-date" />
        </h3>
        <Day key={date} userId={p.user_id} name={p.name} date={date} />
      </section>
    </div>
  );
}
