"use client";
/* The app-wide upload card. Any file sent as JSON (certificates, intake, portal
   requests, manuals, logos, signatures, photos) shows here while it travels:
   its name, the percent on a bar, MB sent of the total, speed, time left and
   Cancel, then "Saving…" while the server stores it. lib/api.js lists the
   uploads; the Shell mounts this once, for the work area and the portal alike.
   The task panel's own uploads keep their inline bar (TaskExtras.jsx). */
import { useEffect, useRef, useState } from "react";
import { cancelUpload, watchUploads } from "@/lib/api";
import { progressLine, rateTracker } from "@/lib/uploadRate";

export default function UploadMonitor() {
  const [list, setList] = useState([]);
  const trackers = useRef(new Map()); /* id -> rateTracker */
  useEffect(() => watchUploads((ups) => {
    const t = trackers.current;
    for (const id of [...t.keys()]) if (!ups.some((u) => u.id === id)) t.delete(id);
    setList(ups.map((u) => {
      if (!t.has(u.id)) t.set(u.id, rateTracker());
      return { ...u, ...t.get(u.id)(u.loaded, u.total) };
    }));
  }), []);
  if (!list.length) return null;
  return (
    <div role="status" aria-live="polite" style={{ position: "fixed", right: 16, bottom: 16, zIndex: 1000, width: "min(360px, calc(100vw - 32px))", display: "flex", flexDirection: "column", gap: 8 }}>
      {list.map((u) => {
        const saving = u.done || u.pct >= 100;
        return (
          <div key={u.id} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "10px 12px", boxShadow: "0 8px 24px rgba(15,23,42,.18)", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>{saving ? "Saving" : "Uploading"} {u.label}</span>
              {!saving && <button type="button" onClick={() => cancelUpload(u.id)} style={{ background: "none", border: 0, padding: 0, color: "var(--danger)", fontWeight: 700, cursor: "pointer", font: "inherit", fontSize: 12 }}>Cancel</button>}
            </div>
            <span className="prog" style={{ height: 18, borderRadius: 9, position: "relative" }}>
              <i style={{ width: `${u.pct}%`, transition: "width .2s" }} />
              <b style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 11, color: u.pct > 50 ? "#fff" : "var(--text)" }}>{u.pct}%</b>
            </span>
            <span className="mini">{saving ? "Saving on the server…" : progressLine(u)}</span>
            {!saving && <small style={{ color: "var(--danger)", fontSize: 11, fontWeight: 600 }}>⚠ Keep this tab open until 100%.</small>}
          </div>
        );
      })}
    </div>
  );
}
