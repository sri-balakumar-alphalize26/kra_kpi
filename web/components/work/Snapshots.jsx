"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button, ErrorState, IconButton, Lozenge, Modal, PageHeader, Skeleton, Tabs } from "@/components/ui";
import * as M from "@/lib/services/more";

/* The server sends saved / reopened times already in IST ("17 Oct 2026, 01:10 AM IST"),
   the exact strings Odoo and the phone print. Formatting the raw UTC value here used the
   browser's clock instead, so the three could disagree. genTime is the time half. */
const genTime = (s) => (s.generated_at_display || "").split(", ")[1] || "";
/* Both list routes clamp limit_days to 1..365 — Odoo's picker is 7 / 30 / 90 / 1 year. */
const RANGES = [{ key: 7, label: "7 days" }, { key: 30, label: "30 days" }, { key: 90, label: "90 days" }, { key: 365, label: "1 year" }];

/* Presence vs standard (the frozen met_standard / standard_hours on the row, as
   Odoo's tree shows it: green when the day met the rule of its time, red when not). */
function Presence({ s, light = false }) {
  if (!s.presence_display) return null;
  const ok = !!s.met_standard;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <span style={{ background: ok ? "#16A34A" : "#DC2626", color: "#fff", borderRadius: 6, padding: "1px 7px", fontSize: 11.5, fontWeight: 700 }}>{s.presence_display}</span>
      <span style={{ fontSize: 11.5, opacity: light ? .9 : 1, color: light ? undefined : "var(--subtle)" }}>presence vs {s.standard_hours || 0}h standard</span>
    </span>
  );
}

/* Odoo's "Reopened workday" box: who, when, and why an admin reopened this day —
   the reason these figures may differ from a summary already sent. */
function ReopenBox({ s }) {
  if (!s.reopen_reason && !s.reopened_at) return null;
  return (
    <div style={{ border: "1px solid var(--pri-important, #F59E0B)", borderRadius: 8, padding: "8px 10px", margin: "0 0 10px", background: "var(--surface)" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--lz-paused, #B45309)", marginBottom: s.reopen_reason ? 4 : 0 }}>
        ↺ Reopened workday
        {s.reopened_by && <span style={{ fontWeight: 400, color: "var(--subtle)" }}> — by {s.reopened_by}</span>}
        {s.reopened_at && <span style={{ fontWeight: 400, color: "var(--subtle)" }}> on {s.reopened_at_display || s.reopened_at}</span>}
      </div>
      {s.reopen_reason && <div style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>{s.reopen_reason}</div>}
    </div>
  );
}

/* Workday snapshots: end-of-day summary images by date (mine, or every
   developer's for admins). Click → full-size view with download. */
export default function Snapshots({ mine = false }) {
  const sp = useSearchParams();
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [view, setView] = useState(null); /* { snap, src } */
  const load = () => (mine ? M.fetchMySnapshots(days) : M.fetchSnapshots(days)).then((r) => { if (r?.status) setData(r.days || []); else setErr(r?.message || "Unavailable"); }).catch((e) => setErr(e.message));
  useEffect(() => { setData(null); load(); }, [days, mine]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = async (snap) => {
    setView({ snap, src: "" });
    try {
      const r = await (mine ? M.fetchMySnapshotImage(snap.snapshot_id) : M.fetchSnapshotImage(snap.snapshot_id));
      const src = r?.status ? M.snapshotDataUrl(r) : "";
      setView({ snap, src, fileName: r?.file_name || "", err: src ? "" : (r?.message || "Could not load") });
    }
    catch (e) { setView({ snap, src: "", err: e.message }); }
  };
  useEffect(() => { const f = sp.get("focus"); if (f && data) { for (const d of data) for (const s of (d.devs || d.snapshots || [])) if (String(s.snapshot_id) === f) open(s); } }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <PageHeader crumbs={[{ label: mine ? "Your work" : "Reports" }, { label: mine ? "My snapshots" : "Workday snapshots" }]} title={mine ? "My snapshots" : "Workday snapshots"} meta="End-of-workday summary images">
        <Tabs items={RANGES} value={days} onChange={setDays} />
      </PageHeader>
      <div className="page">
        {err && <ErrorState error={{ message: err }} onRetry={load} />}
        {!data && !err && <div className="cardbox"><Skeleton rows={3} /></div>}
        {data && !data.length && <div className="cardbox"><span className="mini">No snapshots in this period.</span></div>}
        {(data || []).map((d) => {
          const snaps = d.devs || d.snapshots || [];
          return (
            <div key={d.date} className="cardbox">
              <h2>{d.label || d.date} <small>{snaps.length} snapshot{snaps.length === 1 ? "" : "s"}</small></h2>
              <div className="gal">
                {snaps.map((s) => (
                  <figure key={s.snapshot_id} style={{ margin: 0, cursor: "pointer" }} onClick={() => open(s)}>
                    <div className="thumb" style={{ background: "linear-gradient(135deg,#1E40AF,#2563EB)", color: "#fff", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                      <b>{mine ? d.label || d.date : s.name || "—"}</b>
                      <span style={{ fontSize: 11, opacity: .9 }}>{genTime(s) ? `${genTime(s)} · ` : ""}{s.productive_display || "—"} productive{s.task_count != null ? ` · ${s.task_count} tasks` : ""}</span>
                      <span style={{ marginTop: 4 }}><Presence s={s} light /></span>
                      {(s.reopened_at || s.reopen_reason) && <Lozenge tone="review" style={{ marginTop: 4 }}>Reopened</Lozenge>}
                    </div>
                  </figure>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <Modal open={!!view} onClose={() => setView(null)} title={view ? `${view.snap.name || "Snapshot"}${genTime(view.snap) ? ` · ${genTime(view.snap)}` : ""}` : ""} width={900}
        footer={view?.src ? <><a className="btn" href={view.src} download={view.fileName || view.snap.image_name || "snapshot.png"}>Download</a><Button kind="primary" onClick={() => setView(null)}>Close</Button></> : null}>
        {view && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 10, fontSize: 12.5 }}>
            <Presence s={view.snap} />
            <span className="mini">Productive {view.snap.productive_display || "—"} · {view.snap.task_count || 0} task{view.snap.task_count === 1 ? "" : "s"}</span>
            {view.snap.generated_at_display && <span className="mini">Saved {view.snap.generated_at_display}</span>}
          </div>
        )}
        {/* Odoo order: the end-of-day note, then the reopen box, then the image. */}
        {view?.snap?.note && <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", marginBottom: 10, background: "var(--hover)" }}><div className="mini" style={{ fontWeight: 700, marginBottom: 4 }}>End-of-day note</div><div style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>{view.snap.note}</div></div>}
        {view && <ReopenBox s={view.snap} />}
        {view && (view.err ? <span className="err" style={{ color: "var(--danger)" }}>{view.err}</span> : view.src ? <img src={view.src} alt="Workday snapshot" style={{ width: "100%", borderRadius: 10 }} /> : <Skeleton rows={6} />)}
      </Modal>
    </>
  );
}
