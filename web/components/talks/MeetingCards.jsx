"use client";
/* One meeting with everything saved on it, and meetings grouped by date: the
   web port of Odoo's KpiMeetingCard / KpiMeetingDays (kpi_client_talks.js),
   shared by Client Talks › 📅 Meetings and 📅 Meetings in a task's details.
   Closed, a card is one row: date, time, task and status; tap it to see
   attendance, summary, action items, recording and transcript. */
import { useState } from "react";
import { Lozenge } from "@/components/ui";
import * as M from "@/lib/services/meetings";
import { colour } from "@/lib/services/talks";

const BOX = { border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" };
const SOFT = { background: "var(--hover)", borderRadius: 6, padding: 8, fontSize: 12.5, whiteSpace: "pre-wrap" };

export function MeetingCard({ meeting: m, onOpen, tone, dayLabel, startOpen }) {
  const [open, setOpen] = useState(!!startOpen);
  const [full, setFull] = useState(false);
  const [error, setError] = useState("");
  const c = tone || colour(3);
  const [stTone] = M.STATES[m.state] || ["todo"];
  /* Join as ME: the room opens with my name from Odoo. The tab is opened
     inside the click so a pop-up blocker doesn't stop it. */
  const join = async (e) => {
    e.stopPropagation();
    setError("");
    const w = window.open("", "_blank");
    try { const url = await M.myLink(m.id); if (w) w.location = url; else window.location = url; }
    catch (er) { if (w) w.close(); setError(er.message || "Could not open the meeting."); }
  };
  return (
    <div className="cardbox" style={{ padding: "8px 12px", marginBottom: 8, boxShadow: `inset 5px 0 0 ${c.bar}`, gap: 8 }}>
      <div role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((v) => !v); } }}
        style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, cursor: "pointer" }}>
        <span className="mini">{open ? "▾" : "▸"}</span>
        {dayLabel && <b>{dayLabel}</b>}
        <b>{m.when}</b>
        {m.minutes > 0 && <span className="mini">· {m.minutes} min</span>}
        {m.ref && <Lozenge tone="neutral" style={{ textTransform: "none" }}>{m.ref}</Lozenge>}
        <b style={{ fontSize: 13 }}>{m.title || m.name}</b>
        {m.title && m.name !== m.title && <span className="mini">· {m.name}</span>}
        <Lozenge tone={stTone}>{m.state_label}</Lozenge>
        {m.internal && <Lozenge tone="neutral" style={{ textTransform: "none" }}>Internal</Lozenge>}
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
          {m.can_join && <button type="button" className="btn btn-primary" style={{ height: 28, fontSize: 12.5 }} onClick={join}>🎥 Join meeting</button>}
          {onOpen && m.kpi_id && <button type="button" className="btn btn-ghost" style={{ height: 28, fontSize: 12.5 }} onClick={(e) => { e.stopPropagation(); onOpen(m); }}>{m.is_general ? "💬 Open chat" : "↗ Open task"}</button>}
        </span>
      </div>
      {error && <div className="callout" style={{ background: "var(--lz-paused-bg)", borderColor: "var(--pri-important)" }}>{error}</div>}
      {open && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="mini" style={{ lineHeight: 1.6 }}>
              {m.local_when && <>{m.local_when}<br /></>}
              Organizer <b style={{ color: "var(--text)" }}>{m.organizer || "nobody yet"}</b><br />
              {m.asked_by && <>Asked by {m.asked_by} (client)<br /></>}
              {m.client && <>Client {m.client}{m.db ? ` · ${m.db}` : ""}<br /></>}
              {m.booked && <>Booked {m.booked}</>}
            </div>
            <div style={BOX}>
              <div className="mini" style={{ background: "var(--hover)", padding: "4px 8px", fontWeight: 600 }}>👥 Attendance</div>
              {!m.attendance.length && <div className="mini" style={{ padding: "4px 8px" }}>Nobody joined yet.</div>}
              {m.attendance.map((p, i) => (
                <div key={i} style={{ display: "flex", padding: "4px 8px", fontSize: 12.5, borderTop: "1px solid var(--border)" }}>
                  <span>{p.name}{!p.staff && " (client)"}</span>
                  <span className="mini" style={{ marginLeft: "auto" }}>
                    {p.absent ? "❌ absent" : <>{p.joined && <>{p.joined} – {p.left || "now"} · </>}{p.minutes} min{p.removed && " ⚠️"}</>}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={SOFT}><b>📝 Summary</b><br />{m.summary || <span className="mini">No summary yet.</span>}</div>
            <div style={SOFT}><b>✅ Action items</b><br />{m.action_items || <span className="mini">None written.</span>}</div>
            {m.notes && <div className="mini" style={{ whiteSpace: "pre-wrap" }}>🔒 {m.notes}</div>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ ...BOX, padding: 8 }}>
              <b style={{ fontSize: 12.5 }}>🎧 Recording</b>
              {!m.recordings.length && <div className="mini">No recording.</div>}
              {m.recordings.map((r) => (
                <div key={r.id} style={{ marginTop: 4 }}>
                  <audio controls preload="none" src={r.url} style={{ width: "100%" }} />
                  <a className="mini" href={`${r.url}?download=true`}>{r.name}</a>
                </div>
              ))}
            </div>
            <div style={{ ...BOX, padding: 8, fontSize: 12.5 }}>
              <b>💬 Transcript</b>
              {!m.transcript ? <div className="mini">No transcript.</div> : (
                <>
                  <div style={full ? { whiteSpace: "pre-wrap", maxHeight: 360, overflow: "auto" } : { whiteSpace: "pre-wrap", maxHeight: "4.5em", overflow: "hidden" }}>{m.transcript}</div>
                  <button type="button" className="btn btn-ghost" style={{ height: 24, fontSize: 12, padding: 0 }} onClick={() => setFull((v) => !v)}>{full ? "▴ Show less" : "▸ Show full transcript"}</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* Meetings grouped by date (Odoo KpiMeetingDays). `compact` starts every card closed. */
export function MeetingDays({ days, onOpen, compact }) {
  return (
    <div>
      {days.map((day) => (
        <div key={day.date}>
          <div className="mini" style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, margin: "8px 0" }}>
            <span style={{ flex: 1, borderTop: "1px solid var(--border)" }} />{day.label}{day.upcoming && " · upcoming"}<span style={{ flex: 1, borderTop: "1px solid var(--border)" }} />
          </div>
          {day.meetings.map((m, i) => <MeetingCard key={m.id} meeting={m} onOpen={onOpen} tone={colour(i + 3)} dayLabel={day.label} startOpen={!compact} />)}
        </div>
      ))}
    </div>
  );
}
