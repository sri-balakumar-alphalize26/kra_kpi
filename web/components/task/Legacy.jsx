"use client";
/* Bugs / updates about a requirement from the OLD database (lib/services/legacy):
   the "🗄️ Old DB" badge on list rows, the voice-note players, and the KPI
   Details card in the task's "📎 From the client" block. Admins and managers
   fill the card in (a Request ID links and renumbers the task); clients read it. */
import { useEffect, useState } from "react";
import { Button, Field, Input, Lozenge, useFlags } from "@/components/ui";
import { href } from "@/lib/api";
import * as L from "@/lib/services/legacy";

const TA = { border: 0, background: "none", outline: 0, resize: "none", width: "100%", height: "100%", font: "inherit", color: "inherit" };

/* On a row that carries legacy_req_link / legacy_status. Nothing otherwise. */
export function OldDbBadge({ t, style }) {
  if (!t?.legacy_req_link) return null;
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center", ...style }}>
      <Lozenge tone="review" style={{ textTransform: "none" }} title="About a requirement from the old database">🗄️ Old DB</Lozenge>
      {t.legacy_status === "pending" && <Lozenge tone="paused" style={{ textTransform: "none" }} title={L.PENDING_LABEL}>Pending</Lozenge>}
    </span>
  );
}

/* The client's voice notes, played in place. The urls are Odoo paths: through the proxy. */
export function VoiceNotes({ notes }) {
  if (!notes?.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {notes.map((v, i) => (
        <div key={`${v.url}${i}`} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span className="mini">🎤 {v.name}</span>
          <audio controls preload="none" src={href(v.url)} style={{ width: "100%", maxWidth: 420, height: 36 }} />
        </div>
      ))}
    </div>
  );
}

/* /kra_kpi/legacy/get for one task: [answer | null, reload]. */
export function useLegacy(kpiId) {
  const [res, setRes] = useState(null);
  const load = () => L.getLegacy(kpiId).then((r) => setRes(r?.status ? r : null)).catch(() => setRes(null));
  useEffect(() => { setRes(null); if (kpiId) load(); }, [kpiId]); // eslint-disable-line react-hooks/exhaustive-deps
  return [res, load];
}

/* The KPI Details card. res: the /kra_kpi/legacy/get answer (legacy truthy). */
export function LegacyCard({ kpiId, res, onSaved }) {
  const flags = useFlags();
  const lg = res.legacy;
  const [edit, setEdit] = useState(null); /* {ref, name, note} while editing */
  const [busy, setBusy] = useState(false);
  const confirmed = lg.status === "confirmed";
  const save = async () => {
    setBusy(true);
    try {
      const r = await L.saveLegacy(kpiId, edit);
      if (!r?.status) { flags.err(r?.message || "Could not save the KPI Details."); return; }
      flags.ok(r.ref ? `${r.message || "KPI Details saved."} The task is now ${r.ref}.` : r.message || "KPI Details saved.");
      setEdit(null);
      onSaved?.();
    } catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="callout" style={{ flexDirection: "column", alignItems: "stretch", gap: 8, background: "var(--lz-review-bg)", borderColor: "var(--lz-review)", color: "inherit", margin: "6px 0" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <Lozenge tone="review" style={{ textTransform: "none" }}>🗄️ Old DB Requirement</Lozenge>
        <Lozenge tone={confirmed ? "done" : "paused"} style={{ textTransform: "none" }}>{confirmed ? "Confirmed with client" : L.PENDING_LABEL}</Lozenge>
        {res.can_edit && !edit && <span style={{ marginLeft: "auto" }}><Button size="sm" kind="ghost" icon="pen" onClick={() => setEdit({ ref: lg.ref || "", name: lg.name || "", note: lg.note || "" })}>Edit</Button></span>}
      </div>
      <VoiceNotes notes={lg.voice_notes} />
      {lg.transcript && <p className="mini" style={{ margin: 0, whiteSpace: "pre-wrap" }}><b>Transcript:</b> {lg.transcript}</p>}
      {edit ? (
        <div className="reveal" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="grid2">
            <Field label="Request ID" hint="Links the task under that old requirement, e.g. REQ-012."><Input value={edit.ref} onChange={(e) => setEdit({ ...edit, ref: e.target.value })} onBlur={() => setEdit((x) => ({ ...x, ref: L.normalizeRef(x.ref) }))} placeholder="REQ-012" /></Field>
            <Field label="Task name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Name of the old requirement" /></Field>
          </div>
          <Field label="Message"><span className="input ta" style={{ height: 72 }}><textarea value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} style={TA} /></span></Field>
          <div className="pillset"><Button size="sm" kind="ghost" onClick={() => setEdit(null)} disabled={busy}>Cancel</Button><Button size="sm" kind="primary" busy={busy} onClick={save}>Save</Button></div>
        </div>
      ) : (
        <>
          {lg.note && <p style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{lg.note}</p>}
          <dl className="details" style={{ margin: 0 }}>
            <dt>Request ID</dt><dd>{lg.ref || <span className="mini">{L.PENDING_LABEL}</span>}</dd>
            <dt>Task name</dt><dd>{lg.name || <span className="mini">{L.PENDING_LABEL}</span>}</dd>
          </dl>
          {lg.confirmed_by && <span className="mini">Confirmed by {lg.confirmed_by}{lg.confirmed_on ? ` on ${lg.confirmed_on.slice(0, 10)}` : ""}</span>}
        </>
      )}
    </div>
  );
}

/* The card on its own, for screens without the task panel (the portal's request sheet). */
export function LegacyBlock({ kpiId, onSaved }) {
  const [res, reload] = useLegacy(kpiId);
  if (!res?.legacy) return null;
  return <LegacyCard kpiId={kpiId} res={res} onSaved={() => { reload(); onSaved?.(); }} />;
}
