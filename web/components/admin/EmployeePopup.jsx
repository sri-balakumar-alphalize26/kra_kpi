"use client";
/* The Dashboard's employee popup: one person, four tabs.
     header    name + role; one status line (what they are doing right now, from
               the live row the page already polls); Call / WhatsApp / Nudge,
               Reopen workday; ✕ (and Esc) closes
     Overview  the day and the workload in numbers, and their contact card
     Today     today's summary (EmployeeDay's DaySummary, refreshed every 15 s)
     Workload  every open task, questions waiting on a manager, today's meetings
     History   any earlier day and the last 30 days' attendance (working days only)
   Data: the live row, /kpi_owner/employee_profile (once per open) and
   /kpi_owner/employee_day (Today / History, only while that tab is shown).
   The PIN is never shown — only whether it is still the default. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Avatar, Button, Lozenge, Modal, Skeleton, Tabs, useDialogs, useFlags } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import * as A from "@/lib/services/admin";
import { resetPassword } from "@/lib/services/settings";
import { DaySummary } from "./EmployeeDay";
import { ST, TS, cardText, clock, hm, statusOf, timerLevel } from "./employeeStatus";

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dmy = (s, o = { day: "numeric", month: "short" }) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", o) : "");
const TONE = { running: "progress", paused: "paused", todo: "todo", hold: "danger", approval: "review", done: "done" };

/* Outline icons, one stroke style for every action button (no emoji). */
const PATH = {
  phone: "M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2",
  chat: "M21 12a8 8 0 01-12 7l-6 2 2-5.5A8 8 0 1121 12z",
  bell: "M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 003.4 0",
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3",
  key: "M15 7a4 4 0 11-3.9 5H8v3H5v-3H3v-3h8.1A4 4 0 0115 7z",
  x: "M6 6l12 12M18 6L6 18",
};
const Ic = ({ n, size = 15 }) => <svg className="ep-ic" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"><path d={PATH[n]} /></svg>;

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
  const level = timerLevel(p, s);
  const c = prof?.contact;
  const absent = s === "absent" && !p.day_done;
  /* "Working on REQ-068 · 1h 20m" → "Working · on REQ-068 · 1h 20m"; "Absent" →
     "Absent · no workday started today": the status is said once. */
  const detail = line.replace(new RegExp(`^${ST[s]}\\s*`, "i"), "").replace(/^·\s*/, "");
  const head = s === "absent" ? `${p.day_done ? "Workday ended" : "Absent"} · ${(p.day_done ? sub : sub || "no workday started today").toLowerCase()}`
    : `${ST[s]} · ${detail || line}`;
  const second = s === "absent" ? "" : sub;

  const nudge = async () => {
    setAsking(true);
    const v = await dlg.form({ title: absent ? `Ask ${p.name} to start their workday` : `Nudge ${p.name}`, text: absent ? "They get a notification asking them to start their workday." : "They get a notification that you are checking in.", fields: [{ key: "note", label: "Note (optional)", value: "", required: false }], confirmLabel: "Send nudge" });
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
  const resetPin = async () => {
    setAsking(true);
    const ok = await dlg.confirm({ title: `Reset ${p.name}'s PIN?`, text: "Their app PIN goes back to the default and they must choose a new one the next time they sign in.", confirmLabel: "Reset PIN", danger: true });
    setAsking(false);
    if (!ok) return;
    setBusy("pin");
    try { A.assertOk(await resetPassword(p.user_id), "Could not reset the PIN."); flags.ok(`${p.name}'s PIN was reset — they set a new one at next sign-in.`); loadProfile(); }
    catch (e) { flags.err(e.message); } finally { setBusy(""); }
  };

  return (
    <Modal open onClose={() => { if (!asking) onClose(); }} width={920}
      title={<span className="ep-titlebar">
        <span className="ep-title">{p.name}<small>{c?.role || p.role || "Developer"}</small></span>
        <button type="button" className="ep-x" aria-label="Close" title="Close (Esc)" onClick={onClose}><Ic n="x" size={18} /></button>
      </span>}>
      <div className="ep">
        {/* ---- one status line, then the actions ---- */}
        <div className={`ep-head s-${s} ${level ? `t-${level}` : ""}`}>
          <span className="d3-av"><Avatar name={p.name} uid={p.user_id} size={44} /><i /></span>
          <div className="ep-now">
            <b>{head}</b>
            {second && <small>{second}</small>}
            {p.activity_note && s === "working" && <small>“{p.activity_note}”</small>}
            {(p.active_tasks || []).length > 1 && <small>{p.active_tasks.length} tasks running at once</small>}
            {p.reopened_reason && <small className="ep-warn">Reopened{p.reopened_by ? ` by ${p.reopened_by}` : ""}: {p.reopened_reason}</small>}
          </div>
          <div className="ep-acts">
            {c?.mobile && <a className="btn btn-ghost ep-act" href={`tel:+${c.dial}${c.mobile}`} title={`Call +${c.dial} ${c.mobile}`}><Ic n="phone" />Call</a>}
            {c?.whatsapp && <a className="btn btn-ghost ep-act" href={`https://wa.me/${c.whatsapp}`} target="_blank" rel="noopener noreferrer" title={`WhatsApp +${c.whatsapp}`}><Ic n="chat" />WhatsApp</a>}
            <button type="button" className="btn btn-ghost ep-act" disabled={busy === "nudge"} onClick={nudge}><Ic n="bell" />{absent ? "Nudge: start workday" : "Nudge"}</button>
            {p.day_done && <button type="button" className="btn btn-primary ep-act" disabled={busy === "reopen"} onClick={reopen}><Ic n="undo" />Reopen workday</button>}
          </div>
        </div>

        <Tabs items={[{ key: "overview", label: "Overview" }, { key: "today", label: "Today" }, { key: "workload", label: "Workload", count: prof?.workload?.open }, { key: "history", label: "History" }]} value={tab} onChange={setTab} />

        <div className="ep-body">
          {profErr && (tab === "overview" || tab === "workload") && <div className="callout danger">{profErr}</div>}
          {tab === "overview" && <Overview p={p} prof={prof} onResetPin={resetPin} pinBusy={busy === "pin"} />}
          {tab === "today" && <Day userId={p.user_id} name={p.name} onNudge={nudge} />}
          {tab === "workload" && <Workload prof={prof} />}
          {tab === "history" && <History p={p} prof={prof} />}
        </div>
      </div>
    </Modal>
  );
}

/* ---------------- Overview ---------------- */
function Overview({ p, prof, onResetPin, pinBusy }) {
  if (!prof) return <Skeleton rows={6} />;
  const w = prof.workload, c = prof.contact, att = prof.attendance?.totals || {};
  const pct = Math.min(100, ((p.productive_today || 0) / (8 * 3600)) * 100);
  return (
    <div className="ep-grid">
      <div className="ep-tiles">
        <div className="d3-tile"><div className="t">Productive today</div><div className="v">{hm(p.productive_today)}</div><div className="d3-bar"><i style={{ width: `${pct}%` }} /></div><div className="n" style={{ marginTop: 4 }}>of an 8-hour day</div></div>
        <div className="d3-tile"><div className="t">Done</div><div className="v d3-ok">{w.done_today} <small>today</small></div><div className="n">{w.done_week} this week · {w.done_month} this month</div></div>
        <div className="d3-tile"><div className="t">Open tasks</div><div className="v">{w.open}</div><div className="n">{w.counts.running} running · {w.counts.paused} paused · {w.counts.todo} to do · {w.counts.approval} approval</div></div>
        <div className="d3-tile"><div className="t">Deadlines</div><div className={`v ${w.overdue ? "d3-bad" : ""}`}>{w.overdue}</div><div className={`n ${w.overdue ? "d3-bad" : ""}`}>overdue · {w.due_week} due this week</div></div>
        <div className="d3-tile"><div className="t">Estimate vs spent</div><div className={`v ${w.spent_total > w.est_total && w.est_total ? "d3-bad" : ""}`}>{w.spent_total}h <small>/ {w.est_total}h</small></div><div className="n">on open tasks</div></div>
        <div className="d3-tile"><div className="t">Attendance · 30 days</div><div className="v">{att.on_time || 0}<small> on time</small></div>
          <div className="n">{att.late || 0} late · {att.absent || 0} absent · of {att.working_days || 0} working day{att.working_days === 1 ? "" : "s"}</div></div>
      </div>
      <section className="ep-box">
        <h3>Contact & login</h3>
        <dl className="ep-dl">
          <dt>Login mobile</dt><dd>{c.mobile ? `+${c.dial} ${c.mobile}` : "—"}{c.country ? ` · ${c.country}` : ""}</dd>
          <dt>WhatsApp</dt><dd>{c.whatsapp ? `+${c.whatsapp}` : <span className="d3-bad">no number — they can't be messaged</span>}</dd>
          <dt>App login</dt><dd className="ep-pin">{c.app_login_enabled ? "On" : <span className="d3-bad">Off</span>}
            {c.pin_is_default && <><span className="ep-amber">Default PIN – not changed</span>
              <button type="button" className="btn btn-ghost ep-act sm" disabled={pinBusy} onClick={onResetPin}><Ic n="key" size={13} />Reset PIN</button></>}</dd>
          <dt>Last sign-in</dt><dd>{c.last_app_login ? `${c.last_app_login}${c.last_device ? ` · ${c.last_device}` : ""}` : "never"}</dd>
          <dt>ERP login</dt><dd>{c.login}</dd>
          <dt>Multitask</dt><dd>{c.allow_multitask ? "May run several tasks at once" : "One task at a time"}</dd>
        </dl>
      </section>
      {(prof.questions.length > 0 || prof.meetings_today.length > 0) && (
        <section className="ep-box">
          <h3>Waiting on</h3>
          {prof.questions.length > 0 && <p className="mini" style={{ margin: 0 }}>{prof.questions.length} question{prof.questions.length === 1 ? "" : "s"} to a manager, oldest {Math.max(...prof.questions.map((q) => q.days))} day(s)</p>}
          {prof.meetings_today.map((m) => <p key={m.id} className="mini" style={{ margin: "4px 0 0" }}>{m.time} {m.name} · {m.state}</p>)}
        </section>
      )}
    </div>
  );
}

/* ---------------- Today / any day ---------------- */
function Day({ userId, name, date, onNudge }) {
  const isToday = !date;
  const day = useResource(A.EMPLOYEE_DAY_PATH, A.employeeDayParams(userId, date || null), { pollMs: isToday ? 15000 : 0, ttl: isToday ? 5000 : 60000 });
  const d = day.data;
  if (day.error && !d) return <div className="callout danger">{day.error.message}</div>;
  if (!d) return <Skeleton rows={6} />;
  if (d.status === false) return <div className="callout danger">{d.message || "Could not load that day."}</div>;
  if (d.started === false) {
    return isToday ? (
      <div className="ep-empty">
        <b>Not started yet</b>
        <span>{name} hasn't started a workday today.</span>
        {onNudge && <button type="button" className="btn btn-primary ep-act" onClick={onNudge}><Ic n="bell" />Nudge to start workday</button>}
      </div>
    ) : <div className="ep-empty"><b>No workday</b><span>{name} didn't start a workday on {dmy(date, { weekday: "short", day: "numeric", month: "short" })}.</span></div>;
  }
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
  const anything = w.open > 0 || w.done_month > 0;
  return (
    <div className="ep-grid">
      {anything && (
        <div className="ep-chips">
          {["running", "paused", "todo", "hold", "approval"].map((k) => (
            <Lozenge key={k} tone={w.counts[k] ? TONE[k] : "neutral"} className={w.counts[k] ? "" : "ep-zero"} style={{ textTransform: "none" }}>{TS[k]} {w.counts[k] || 0}</Lozenge>
          ))}
          <Lozenge tone={w.done_month ? "done" : "neutral"} className={w.done_month ? "" : "ep-zero"} style={{ textTransform: "none" }}>Done {w.done_today} today · {w.done_week} this week · {w.done_month} this month</Lozenge>
          {w.overdue > 0 && <Lozenge tone="danger" style={{ textTransform: "none" }}>{w.overdue} overdue</Lozenge>}
          {w.due_week > 0 && <Lozenge tone="paused" style={{ textTransform: "none" }}>{w.due_week} due this week</Lozenge>}
        </div>
      )}
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
const ATT = { on_time: "On time", late: "Late", absent: "Absent", off: "Weekend", holiday: "Holiday", before_join: "Before joining", pending: "Not yet" };
function History({ p, prof }) {
  const y = new Date(); y.setDate(y.getDate() - 1);
  const [date, setDate] = useState(ymd(y));
  const today = ymd(new Date());
  const att = prof?.attendance;
  return (
    <div className="ep-grid">
      <section className="ep-box">
        <h3>Attendance · last 30 days {att && <span className="mini">(working days only · late after {clock(att.cutoff)}{att.joined ? ` · joined ${dmy(att.joined)}` : ""})</span>}</h3>
        {!att ? <Skeleton rows={2} /> : (
          <>
            <div className="ep-att" role="list">
              {att.days.map((d) => (
                <button key={d.date} type="button" role="listitem" className={`ep-day a-${d.status} ${d.date === date ? "on" : ""}`}
                  title={`${dmy(d.date, { weekday: "short", day: "numeric", month: "short" })} · ${ATT[d.status] || d.status}${d.first_login ? ` · in ${clock(d.first_login)}` : ""}`}
                  onClick={() => d.date < today && setDate(d.date)} disabled={d.date >= today}>
                  <span>{new Date(`${d.date}T00:00:00`).getDate()}</span>
                </button>
              ))}
            </div>
            <div className="ep-chips" style={{ marginTop: 8 }}>
              <Lozenge tone="done" style={{ textTransform: "none" }}>On time {att.totals.on_time}</Lozenge>
              <Lozenge tone="paused" style={{ textTransform: "none" }}>Late {att.totals.late}</Lozenge>
              <Lozenge tone="danger" style={{ textTransform: "none" }}>Absent {att.totals.absent}</Lozenge>
              <span className="mini">of {att.totals.working_days} working days · click a day to see it below · <Link href="/reports/snapshots">Workday snapshots</Link></span>
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
