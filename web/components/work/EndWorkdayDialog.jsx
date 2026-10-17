"use client";
/* End Workday summary, the web port of the Odoo board's / mobile app's modal.
   Opening it only previews the day (/kpi_workday/today_summary, which does not
   close anything); "End workday & send summary" then calls /kpi_workday/end
   with the optional note. Same data and wording as the other two clients.
   "Pause workday" sits here too (as on the Odoo board): stopping for a few
   hours and stopping for good are the same decision, made in one place. */
import { useEffect, useState } from "react";
import { Button, Input, Modal, Skeleton } from "@/components/ui";
import * as S from "@/lib/services/kpiActions";
import WorkdayTimeline from "./WorkdayTimeline";

const NOTE_MAX = 2000;
const AWAY = [["break", "Break"], ["lunch", "Lunch"], ["meeting", "Meeting"], ["no_tasks", "No tasks"], ["other", "Other"], ["away", "Away (system)"], ["other_idle", "Other / Idle"]];
const hhmm = (ts) => (ts ? String(ts).slice(11, 16) || ts : "—");

export default function EndWorkdayDialog({ onClose, onEnded, onPaused, reopened, paused }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    S.getTodaySummary()
      .then((r) => { if (r && r.status === false) throw new Error(r.message || "Could not load today's summary."); setD(r || {}); })
      .catch((e) => setErr(e.message));
  }, []);

  const end = async () => {
    setBusy(true); setErr("");
    try {
      S.assertOk(await S.endWorkday(note.trim().slice(0, NOTE_MAX)), "Could not end the workday.");
      onEnded?.();
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  /* Freeze instead of end: running tasks stop, Presence stops, Resume brings it back today. */
  const pause = async () => {
    setBusy(true); setErr("");
    try { const r = S.assertOk(await S.pauseWorkday(), "Could not pause the workday."); onPaused?.(r.message); }
    catch (e) { setErr(e.message); setBusy(false); }
  };
  const words = note.trim().split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w)).length;

  return (
    <Modal open onClose={busy ? undefined : onClose} title={`End workday${d?.dev ? ` — ${d.dev}` : ""}`} width={780}
      footer={<><Button kind="ghost" onClick={onClose} disabled={busy}>Continue working</Button>{!paused && onPaused && <Button icon="pause" disabled={busy} onClick={pause} title="Stop for now and resume later today — the day stays open">Pause workday</Button>}<Button kind="danger" icon="logout" busy={busy} disabled={!d} onClick={end}>End workday &amp; send summary</Button></>}>
      {!d && !err && <Skeleton rows={6} />}
      {err && <div className="callout" style={{ background: "var(--over-bg)", borderColor: "var(--danger)", color: "var(--over)" }}>{err}</div>}
      {reopened && (
        <div className="callout reveal" style={{ background: "var(--lz-paused-bg)", borderColor: "var(--pri-important)", color: "var(--lz-paused)" }}>
          <span><b>↺ Reopened workday.</b> {reopened.by ? `Reopened by ${reopened.by}` : "This day was reopened"}{reopened.reason ? ` — "${reopened.reason}"` : ""}. Ending it sends an updated summary.</span>
        </div>
      )}
      {d && <Summary d={d} />}
      {d && (
        <label className="field">
          What did you work on today? (optional)
          <span className="input ta" style={{ height: 120 }}>
            <textarea value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Finished the login screen, fixed the invoice total bug, started on reports."
              style={{ border: 0, background: "none", outline: 0, resize: "none", width: "100%", height: "100%", font: "inherit", color: "inherit" }} />
          </span>
          <small className="mini">
            Saved with your workday snapshot and sent in the daily summary.{d.wa_group_end_posts ? ` It is also posted to the team's WhatsApp group (${d.wa_group_name}).` : ""}
            {note.trim() && words < 2 ? " Tip: a few more words make the summary more useful." : ""}
          </small>
        </label>
      )}
    </Modal>
  );
}

/* Also used read-only by Live Tracking (an admin looking at someone's day):
   then the missing-progress list is shown, not the inputs to fill it in. */
export function Summary({ d, readOnly = false }) {
  const away = AWAY.filter(([k]) => (d[`${k}_seconds`] || 0) > 0);
  const tasks = d.tasks || [];
  const multi = d.allow_multitask || tasks.some((t) => t.concurrent);
  return (
    <div className="ewd">
      {d.auto_closed && <div className="callout" style={{ background: "var(--lz-paused-bg)", borderColor: "var(--pri-important)", color: "var(--lz-paused)" }}>Auto-closed earlier by the system.</div>}

      {(d.missing_progress || []).length > 0 && (readOnly
        ? <section className="ewd-box warn"><h3>{d.missing_progress.length} task(s) worked today have no progress update</h3>{d.missing_progress.map((m) => <div key={m.kpi_id} className="mini"><span className="ref">{m.external_ref || `#${m.kpi_id}`}</span> {m.name}</div>)}</section>
        : <MissingProgress items={d.missing_progress} />)}

      <div className="ewd-stats">
        <div className="stat"><small>Login</small><b>{hhmm(d.login_at)}</b><span>{d.session_date || ""}</span></div>
        <div className="stat"><small>Productive</small><b>{d.productive_display || "0h 0m"}</b><span>task time</span></div>
        <div className="stat"><small>Presence</small><b style={{ color: d.met_standard ? "var(--pri-regular)" : "var(--danger)" }}>{d.presence_display || "0h 0m"}</b><span>{d.met_standard ? "✓" : "▾"} {d.standard_display} standard</span></div>
        <div className="stat"><small>Accounted</small><b>{d.accounted_display || "0h 0m"}</b><span>task + meeting + lunch + break + no-tasks + paused</span></div>
        {(d.paused_seconds || 0) > 0 && <div className="stat"><small>Workday paused</small><b>{d.paused_display}</b><span>paused time</span></div>}
      </div>

      {away.length > 0 && (
        <section className="ewd-box">
          <h3>Away time</h3>
          <div className="ewd-away">{away.map(([k, l]) => <span key={k} className="ewd-tag"><b>{d[`${k}_display`]}</b>{l}</span>)}</div>
          {(d.away_events || []).length > 0 && (
            <ul className="ewd-events">
              {d.away_events.map((e, i) => (
                <li key={i}><span className="ewd-tag sm">{e.label}</span>{e.start} – {e.end} ({e.duration_display}){e.from ? ` · from "${e.from}"` : ""}{e.with ? ` · with ${e.with}` : ""}{e.note ? ` — ${e.note}` : ""}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {(d.timeline || []).length > 0 && (
        <section className="ewd-box">
          <h3>Workday map</h3>
          <WorkdayTimeline timeline={d.timeline} />
          <p className="mini" style={{ margin: "8px 0 0" }}>Use Complete for finished tasks — Pause is only for breaks/interruptions.</p>
        </section>
      )}

      <section className="ewd-box">
        <h3>Tasks worked today ({d.task_count ?? tasks.length})</h3>
        {tasks.length ? (
          <table className="table">
            <thead><tr><th>Ref</th><th>Task</th><th className="num">Time</th></tr></thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.kpi_id} style={t.concurrent ? { boxShadow: "inset 3px 0 0 var(--pri-important)" } : undefined}>
                  <td><span className="ref">{t.ref || `#${t.kpi_id}`}</span></td>
                  <td style={{ whiteSpace: "normal" }}>{t.concurrent ? "⚡ " : ""}{t.name}{t.concurrent && <small className="mini" style={{ display: "block" }}>{t.solo_display} alone · {t.shared_display} shared</small>}</td>
                  <td className="num">{t.duration_display}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <span className="mini">No task time logged today.</span>}
        {multi && <p className="mini" style={{ margin: "6px 0 0" }}>⚡ ran at the same time as another task.</p>}
      </section>
    </div>
  );
}

/* Tasks worked on today with no progress note: add one here, or end anyway. */
function MissingProgress({ items }) {
  const [text, setText] = useState({});
  const [saved, setSaved] = useState({});
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState("");
  const save = async (m) => {
    const v = (text[m.kpi_id] || "").trim();
    if (!v) return;
    setBusy(m.kpi_id); setErr("");
    try { S.assertOk(await S.createProgress(m.kpi_id, v.slice(0, 500)), "Could not save the update."); setSaved((s) => ({ ...s, [m.kpi_id]: true })); }
    catch (e) { setErr(e.message); } finally { setBusy(null); }
  };
  const left = items.filter((m) => !saved[m.kpi_id]).length;
  return (
    <section className="ewd-box warn">
      <h3>{left ? `${left} task${left === 1 ? "" : "s"} you worked on today ${left === 1 ? "has" : "have"} no progress update` : "Progress updates added ✓"}</h3>
      <p className="mini" style={{ margin: "0 0 8px" }}>Add one here, or end your day anyway — this will not stop you.</p>
      {items.map((m) => (
        <div key={m.kpi_id} className="ewd-prog">
          <span className="ewd-prog-name"><span className="ref">{m.external_ref || `#${m.kpi_id}`}</span> {m.name}</span>
          {saved[m.kpi_id] ? <span className="mini" style={{ color: "var(--pri-regular)", fontWeight: 700 }}>Saved ✓</span> : (
            <span className="ewd-prog-row">
              <Input value={text[m.kpi_id] || ""} maxLength={500} placeholder="What did you do on this today?" onChange={(e) => setText((t) => ({ ...t, [m.kpi_id]: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter") save(m); }} />
              <Button size="sm" busy={busy === m.kpi_id} disabled={!(text[m.kpi_id] || "").trim()} onClick={() => save(m)}>Save</Button>
            </span>
          )}
        </div>
      ))}
      {err && <small className="err" style={{ color: "var(--danger)" }}>{err}</small>}
    </section>
  );
}
