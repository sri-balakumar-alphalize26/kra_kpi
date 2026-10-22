"use client";
/* The task panel's "Client" tab: every send the client made for this task
   (/kra_kpi/client_sends), oldest first with the newest marked NEW, each with
   its files and what became of it (refused, re-typed, accepted, waiting).
   Below them the old-DB KPI Details card when the task has one. */
import { useEffect, useState } from "react";
import { Lozenge } from "@/components/ui";
import { href } from "@/lib/api";
import * as L from "@/lib/services/legacy";
import { LegacyCard } from "./Legacy";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/* A server UTC "YYYY-MM-DD HH:MM:SS" as "22 Oct 18:05" in the browser's zone
   (the year only when it is not this year). Anything else is passed through. */
const fmtUtc = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s || "");
  if (!m) return s || "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
  if (Number.isNaN(d.getTime())) return s;
  const yr = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${yr} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
/* 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st. */
const ordinal = (n) => {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] || "th"}`;
};
/* ① … ⑳, then the plain number. */
const circled = (n) => (n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : `(${n})`);
const fileIcon = (f) => {
  const n = f?.name || "";
  if (/\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(n)) return "📷";
  if (/\.(mp4|mov|mkv|avi|3gp|m4v)$/i.test(n)) return "🎥";
  if (/\.(webm|ogg|opus|mp3|wav|m4a|aac|amr)$/i.test(n)) return "🎤";
  return "📎";
};
const hasContent = (s) => !!(s?.files?.length || String(s?.description || "").trim() || String(s?.name || "").trim());

/* /kra_kpi/client_sends for one task: [answer | null, reload]. Reloads with the panel (kpi:refresh). */
export function useClientSends(kpiId) {
  const [res, setRes] = useState(null);
  const load = () => L.getClientSends(kpiId).then((r) => setRes(r?.status ? r : null)).catch(() => setRes(null));
  useEffect(() => { setRes(null); if (kpiId) load(); }, [kpiId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const on = () => { if (kpiId) load(); };
    window.addEventListener("kpi:refresh", on);
    return () => window.removeEventListener("kpi:refresh", on);
  }, [kpiId]); // eslint-disable-line react-hooks/exhaustive-deps
  return [res, load];
}

/* The tab is shown only when the client actually sent something (or the old-DB card exists). */
export const hasClientTab = (res) => !!(res && (res.legacy || (res.sends || []).some(hasContent)));

function StatusLine({ s }) {
  if (s.status === "refused") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ color: "var(--danger)", fontWeight: 700, fontSize: 13 }}>❌ Refused{s.refused_by ? ` by ${s.refused_by}` : ""}{s.refused_at ? ` · ${fmtUtc(s.refused_at)}` : ""}</span>
        {s.reason && <span style={{ whiteSpace: "pre-wrap", fontSize: 13 }}><b>Reason:</b> {s.reason}</span>}
      </div>
    );
  }
  if (s.status === "retyped") return <span className="mini">🔁 Re-typed{s.refused_by ? ` by ${s.refused_by}` : ""}{s.refused_at ? ` · ${fmtUtc(s.refused_at)}` : ""}</span>;
  if (s.status === "replaced") return <span className="mini">🔁 Replaced by a later send</span>;
  if (s.status === "accepted") return <span style={{ color: "var(--lz-done)", fontWeight: 700, fontSize: 13 }}>✅ Accepted</span>;
  if (s.status === "waiting") return <span className="mini">⏳ Waiting for decision</span>;
  return null;
}

function SendCard({ s, n, single, isNew }) {
  return (
    <div className="card" style={isNew ? { boxShadow: "0 0 0 1.5px var(--brand)" } : undefined}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <span className="mini">{single ? "" : `${circled(n)} ${ordinal(n)} send · `}{fmtUtc(s.sent_at)}{s.sent_by ? ` · by ${s.sent_by}` : ""}</span>
        {s.ref && <span className="ref">{s.ref}</span>}
        {s.old_db && <Lozenge tone="review" style={{ textTransform: "none" }}>🗄️ Old DB</Lozenge>}
        {isNew && <Lozenge tone="done" style={{ marginLeft: "auto" }}>NEW</Lozenge>}
      </div>
      {s.name && <b style={{ fontSize: 14, overflowWrap: "anywhere" }}>{s.name}</b>}
      {s.description && <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{s.description}</p>}
      {(s.files || []).length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {s.files.map((f, i) => (
            <a key={`${f.att || f.url}${i}`} className="pill" href={href(f.url)} target="_blank" rel="noreferrer" title={f.name} style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "100%", textDecoration: "none" }}>
              <span>{fileIcon(f)}</span><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name || "file"}</span>
            </a>
          ))}
        </div>
      )}
      <StatusLine s={s} />
    </div>
  );
}

/* res: the useClientSends answer; onSaved: after the KPI Details card is saved. */
export default function ClientTab({ kpiId, res, onSaved }) {
  if (!res) return <div className="sec"><span className="mini">Loading…</span></div>;
  const sends = (res.sends || []).filter(hasContent);
  const single = sends.length === 1;
  return (
    <div className="sec" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {sends.map((s, i) => <SendCard key={`${s.round}${i}`} s={s} n={i + 1} single={single} isNew={!single && i === sends.length - 1} />)}
      {!sends.length && !res.legacy && <span className="mini">The client has not sent anything for this task.</span>}
      {res.legacy && <LegacyCard kpiId={kpiId} res={res} onSaved={onSaved} />}
    </div>
  );
}
