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

const NOTE_MAX = 2000;
const AWAY = [["break", "Break"], ["lunch", "Lunch"], ["meeting", "Meeting"], ["no_tasks", "No tasks"], ["other", "Other"], ["away", "Away (system)"], ["other_idle", "Other / Idle"]];
const OUTCOME = { completed: "✓ Completed", submitted: "◑ Verification pending", paused: "⏸ Paused", active: "▶ In progress", moved: "↪ Moved", worked: "Worked" };
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
          <MapBar timeline={d.timeline} />
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

/* ---- Workday Map to-scale bar: a port of Odoo's buildWorkdayTimeline strip /
   ticks / legend (kpi_workday_timeline/workday_timeline.js), which the Odoo End
   Workday modal and Live Tracking draw above the cards. One colour per KIND of
   time; gaps of 5+ minutes with nothing running are hatched as Idle. */
const MAP_IDLE_MIN = 5;
const MAP_CAT = {
  work: ["Working", "#2563EB"], break: ["Break", "#F59E0B"], lunch: ["Lunch", "#EC4899"], meeting: ["Meeting", "#8B5CF6"],
  no_tasks: ["No tasks", "#0891B2"], urgent: ["Urgent", "#EF4444"], away: ["Away", "#64748B"], idle: ["Idle", "#CBD5E1"],
};
const MAP_BREAK_CAT = { break: "break", lunch: "lunch", meeting: "meeting", no_tasks: "no_tasks", urgent: "urgent", away: "away", leave: "away", other: "away" };
const MAP_BREAK_TITLE = { break: "Break", lunch: "Lunch", meeting: "Meeting", no_tasks: "No tasks", urgent: "Urgent", away: "Away", leave: "Leave", other: "Other" };
const IDLE_HATCH = "repeating-linear-gradient(45deg, #CBD5E1 0 4px, #E2E8F0 4px 8px)";
/* 'YYYY-MM-DD HH:MM:SS' UTC → epoch ms (parsed by hand, as Odoo does). */
const mapTs = (ts) => { const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(ts || ""); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null; };
const mapDur = (sec) => { const s = Math.max(0, Math.round(sec || 0)); if (s < 60) return "<1m"; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return !h ? `${m}m` : m ? `${h}h ${m}m` : `${h}h`; };
/* The server prints `time` in the developer's timezone and sends instants in UTC:
   one pair gives the offset, so ticks read in the developer's clock like the chips. */
function mapOffset(nodes) {
  for (const n of nodes) {
    const ts = mapTs(n.ts || n.start_ts), hm = /^(\d{1,2}):(\d{2})/.exec(n.time || "");
    if (ts == null || !hm) continue;
    const dt = new Date(ts);
    let off = (+hm[1] * 60 + +hm[2]) - (dt.getUTCHours() * 60 + dt.getUTCMinutes());
    if (off > 840) off -= 1440;
    if (off < -720) off += 1440;
    return off;
  }
  return -new Date().getTimezoneOffset();
}
const mapHm = (ms, off) => { const dt = new Date(ms + off * 60000); return `${String(dt.getUTCHours()).padStart(2, "0")}:${String(dt.getUTCMinutes()).padStart(2, "0")}`; };

function buildMapBar(timeline, now) {
  const nodes = Array.isArray(timeline) ? timeline : [];
  const off = mapOffset(nodes);
  const startNode = nodes.find((n) => n.kind === "start"), endNode = nodes.find((n) => n.kind === "end");
  const cards = nodes.filter((n) => n.kind === "task" || n.kind === "break").map((n) => {
    const startMs = mapTs(n.start_ts), running = !!n.running;
    const endMs = running ? now : mapTs(n.end_ts);
    const seconds = n.seconds != null ? n.seconds : (startMs != null && endMs != null ? (endMs - startMs) / 1000 : 0);
    const cat = n.kind === "task" ? "work" : (MAP_BREAK_CAT[n.break_type || "other"] || "away");
    const title = n.kind === "task" ? (n.name || n.label || "Task") : (MAP_BREAK_TITLE[n.break_type || "other"] || "Other");
    return { startMs, endMs, running, seconds, cat, title };
  }).filter((c) => c.startMs != null).sort((a, b) => a.startMs - b.startMs);
  const ended = !!(endNode && mapTs(endNode.ts));
  const live = !ended && cards.some((c) => c.running);
  const dayStart = mapTs(startNode?.ts) ?? (cards[0] ? cards[0].startMs : null);
  const lastEnd = cards.reduce((m, c) => Math.max(m, c.endMs ?? c.startMs), dayStart ?? 0);
  const dayEnd = ended ? mapTs(endNode.ts) : Math.max(lastEnd, live ? now : lastEnd);
  if (!cards.length || dayStart == null || !(dayEnd > dayStart)) return null;
  const span = dayEnd - dayStart;
  const pct = (ms) => Math.min(100, Math.max(0, ((ms - dayStart) / span) * 100));
  const strip = [];
  let covered = dayStart;
  for (const c of cards) {
    const end = c.endMs ?? c.startMs, gap = (c.startMs - covered) / 1000;
    if (gap >= MAP_IDLE_MIN * 60) strip.push({ cat: "idle", left: pct(covered), width: pct(c.startMs) - pct(covered), label: `Idle ${mapDur(gap)} (${mapHm(covered, off)}–${mapHm(c.startMs, off)})` });
    strip.push({ cat: c.cat, left: pct(c.startMs), width: Math.max(0.6, pct(end) - pct(c.startMs)), label: `${c.title} · ${mapHm(c.startMs, off)}–${c.running ? "now" : mapHm(end, off)} · ${mapDur(c.seconds)}` });
    covered = Math.max(covered, end);
  }
  /* Hour marks; every 2h on a day longer than 10h so they don't crowd. */
  const ticks = [], H = 3600000, step = span > 10 * H ? 2 : 1;
  for (let t = Math.ceil((dayStart + off * 60000) / H) * H; t - off * 60000 <= dayEnd; t += H) {
    const hour = new Date(t).getUTCHours();
    if (hour % step === 0) ticks.push({ pct: pct(t - off * 60000), label: String(hour).padStart(2, "0") });
  }
  const present = new Set(strip.map((s) => s.cat));
  return { strip, ticks, legend: Object.keys(MAP_CAT).filter((k) => present.has(k)), startLabel: mapHm(dayStart, off), endLabel: ended ? mapHm(dayEnd, off) : "", live };
}

function MapBar({ timeline }) {
  const bar = buildMapBar(timeline, Date.now());
  if (!bar) return null;
  return (
    <div style={{ margin: "2px 0 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontWeight: 700, color: "var(--subtle)", marginBottom: 3 }}>
        <span>Started {bar.startLabel}</span><span>{bar.live ? "● Still working" : bar.endLabel ? `Ended ${bar.endLabel}` : "Not ended yet"}</span>
      </div>
      <div role="img" aria-label="Workday to scale" style={{ position: "relative", height: 18, borderRadius: 9, background: "var(--sunken, #EEF2F7)", overflow: "hidden" }}>
        {bar.strip.map((s, i) => (
          <span key={i} title={s.label} style={{ position: "absolute", top: 0, bottom: 0, left: `${s.left}%`, width: `${s.width}%`, background: s.cat === "idle" ? IDLE_HATCH : MAP_CAT[s.cat][1], cursor: "help" }} />
        ))}
      </div>
      <div style={{ position: "relative", height: 16, marginTop: 2 }}>
        {bar.ticks.map((k, i) => <span key={i} style={{ position: "absolute", left: `${k.pct}%`, transform: "translateX(-50%)", fontSize: 10, color: "var(--subtle)" }}>{k.label}</span>)}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 11, fontWeight: 700, color: "var(--subtle)", marginTop: 2 }}>
        {bar.legend.map((k) => (
          <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <i style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: k === "idle" ? IDLE_HATCH : MAP_CAT[k][1] }} />{MAP_CAT[k][0]}
          </span>
        ))}
        <span style={{ fontWeight: 400 }}>Hover the bar for details.</span>
      </div>
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
