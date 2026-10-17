"use client";
/* Workday Map: the to-scale day bar, then the day's tasks and breaks as cards in
   time order with what changed between each pair. A React port of Odoo's
   renderTimelineHtml (kpi_workday_timeline); the numbers come from
   lib/workdayTimeline, shared with the End Workday popup and Live Tracking.
   Hover the bar or a ↓ line for the full story (native title tooltips). */
import { buildWorkdayTimeline, CATEGORY } from "@/lib/workdayTimeline";

export default function WorkdayTimeline({ timeline, now = Date.now() }) {
  const t = buildWorkdayTimeline(timeline, now);
  if (t.empty) return <div className="wt-empty">No activity recorded yet today.</div>;
  return (
    <div className="wt">
      <div className="wt-bar" role="img" aria-label="Workday to scale">
        {t.strip.map((s, i) => (
          <span key={i} className={`wt-seg${s.cat === "idle" ? " wt-seg-idle" : ""}`} title={s.label}
            style={{ left: `${s.leftPct}%`, width: `${s.widthPct}%`, background: s.color }} />
        ))}
      </div>
      <div className="wt-ticks">{t.ticks.map((k, i) => <span key={i} className="wt-tick" style={{ left: `${k.pct}%` }}>{k.label}</span>)}</div>
      <div className="wt-hint">Hover the bar or a ↓ line for details.</div>
      <div className="wt-legend">
        {t.legend.map((g) => <span key={g.cat} className="wt-legend-item"><i className={`wt-swatch${g.cat === "idle" ? " wt-seg-idle" : ""}`} style={{ background: g.color }} />{g.label}</span>)}
      </div>
      <div className="wt-edge">🌅 Started {t.startLabel}</div>
      {t.items.map((it) => (it.type === "link" ? (
        <div key={it.key} className="wt-row">
          <div className="wt-rail"><span className={`wt-line${it.idleSec ? " wt-line-idle" : ""}`} /></div>
          <div className={`wt-link${it.idleSec ? " wt-link-idle" : ""}`} title={it.long}>↓ {it.short}</div>
        </div>
      ) : <Card key={it.key} it={it} />))}
      {t.live ? <div className="wt-edge wt-edge-live">● Still working</div>
        : <div className="wt-edge">{t.endLabel ? `🌙 Ended ${t.endLabel}` : "⏳ Not ended yet"}</div>}
    </div>
  );
}

function Card({ it }) {
  const color = CATEGORY[it.cat].color;
  const extra = [it.ref, it.visitLabel].filter(Boolean).join(" · ");
  return (
    <div className="wt-row">
      <div className="wt-rail">
        <span className="wt-time">{it.startLabel}</span>
        <span className={`wt-dot${it.running ? " wt-dot-live" : ""}`} style={{ background: color }} />
        <span className="wt-line" />
      </div>
      <div className="wt-card" style={{ borderLeftColor: color }}>
        <div className="wt-card-top">
          <span className="wt-title">{it.title}</span>
          {it.outcomeLabel && <span className={`wt-pill wt-pill-${it.outcomeTone || "muted"}`}>{it.outcomeTone === "live" ? "● " : ""}{it.outcomeLabel}</span>}
        </div>
        <div className="wt-when">{it.startLabel} → {it.running ? "now" : it.endLabel} <span className="wt-dur">· {it.durationLabel}</span></div>
        {extra && <div className="wt-meta">{extra}</div>}
        {it.with && <div className="wt-meta">with {it.with}</div>}
        {it.note && <div className="wt-note">“{it.note}”</div>}
      </div>
    </div>
  );
}
