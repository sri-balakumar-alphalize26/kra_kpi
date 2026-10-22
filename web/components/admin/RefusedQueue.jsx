"use client";
import { useMemo, useState } from "react";
import { Button, ErrorState, Lozenge, Modal, PageHeader, Skeleton, StaleBar, useDialogs, useFlags } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import { invalidate } from "@/lib/api";
import * as A from "@/lib/services/admin";

/* 🚫 Refused: client requests an admin declined (/kpi_pending_queue/refused).
   They are archived, not deleted, with the reason the client was shown.
   ↩️ Restore puts one back in the client queue (Pending), where it can be
   published or refused again. Mirrors the Odoo Client Task Queue's Refused tab. */
const ANSWER = {
  pending: ["⏳ No answer yet", "paused"], accepted: ["✅ Accepted", "done"],
  disputed: ["⚖️ Disagreed", "danger"], withdrawn: ["🗑 Withdrew it", "neutral"], corrected: ["✏️ Sent a correction", "review"],
};

export default function RefusedQueue() {
  const flags = useFlags();
  const dlg = useDialogs();
  const res = useResource(A.REFUSED_PATH, {}, { pollMs: 60000, ttl: 10000 });
  const err = res.data?.status === false ? { message: res.data.message || "Could not load the list." } : res.error;
  const rows = (res.data?.status === false ? null : res.data?.refused) || [];
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState(0);
  const groups = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      const k = String(r.declined_at || "").split(" ")[0] || "—";
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return [...m.entries()];
  }, [rows]);
  const refresh = () => { invalidate(A.REFUSED_PATH); invalidate("/kpi_pending_queue"); res.refresh(); };

  const restore = async (r) => {
    const ref = r.external_ref || `#${r.id}`;
    if (!(await dlg.confirm({ title: `Restore ${ref}?`, text: "It goes back to the client task queue (Pending), where you can publish it or refuse it again. The refusal stays in its history.", confirmLabel: "↩️ Restore" }))) return;
    setBusy(r.id);
    try {
      const x = await A.restoreRefused(r.id);
      if (!x?.status) { flags.err(x?.message || "Could not restore it."); return; }
      flags.ok(x.message || `${ref} is back in the client queue.`);
      refresh();
    } catch (e) { flags.err(e.message); } finally { setBusy(0); }
  };

  return (
    <>
      <PageHeader crumbs={[{ label: "Work" }, { label: "Client task queue", href: "/queue" }, { label: "Refused" }]} title="🚫 Refused requests" meta="Client requests that were declined — kept with their reason, and can be brought back">
        {res.data && !err && <span className="chip">{rows.length} refused</span>}
      </PageHeader>
      <div className="page">
        {err && !res.data?.refused && <ErrorState error={err} onRetry={res.refresh} />}
        {res.stale && <StaleBar error={res.error} onRetry={res.refresh} />}
        {!res.data && !err && <Skeleton rows={6} />}
        {res.data && !err && !rows.length && <div className="callout">Nothing refused. Requests you decline are kept here with their reason.</div>}
        {rows.length > 0 && (
          <div className="cardbox table-scroll" style={{ padding: 0 }}>
            <table className="table">
              <thead><tr><th>Ref</th><th>Request</th><th>Client</th><th>Refused</th><th>By</th><th>Reason</th><th>Times</th><th>Client answer</th><th /></tr></thead>
              <tbody>
                {groups.map(([day, list]) => (
                  [<tr key={`g${day}`} className="group"><td colSpan={9}>{day}</td></tr>,
                    ...list.map((r) => {
                      const [label, tone] = ANSWER[r.client_answer] || [r.client_answer_label || "—", "neutral"];
                      return (
                        <tr key={r.id}>
                          <td><b>{r.external_ref || `#${r.id}`}</b></td>
                          <td style={{ maxWidth: 280 }}>{r.name}</td>
                          <td>{r.client_name}{r.project_name ? <span className="mini"> · {r.project_name}</span> : null}</td>
                          <td className="mini">{r.declined_at}</td>
                          <td className="mini">{r.declined_by || "—"}</td>
                          <td style={{ maxWidth: 260 }}>{r.reason || "—"}{r.note ? <div className="mini" style={{ whiteSpace: "pre-wrap" }}>{r.note}</div> : null}</td>
                          <td>{r.decline_count > 1 ? `${r.decline_count}×` : "1×"}</td>
                          <td><Lozenge tone={tone} style={{ textTransform: "none" }}>{label}</Lozenge></td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            <Button size="sm" kind="ghost" onClick={() => setView(r)}>👁 View</Button>{" "}
                            <Button size="sm" kind="primary" busy={busy === r.id} onClick={() => restore(r)}>↩️ Restore</Button>
                          </td>
                        </tr>
                      );
                    })]
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {view && (
        <Modal open onClose={() => setView(null)} title={`${view.external_ref || `#${view.id}`} — ${view.name}`} width={620}
          footer={<><Button kind="ghost" onClick={() => setView(null)}>Close</Button><Button kind="primary" onClick={() => { const r = view; setView(null); restore(r); }}>↩️ Restore</Button></>}>
          <div className="mini">{view.client_name} · received {view.received_at}{view.submitted_by ? ` by ${view.submitted_by}` : ""}</div>
          <p style={{ whiteSpace: "pre-wrap" }}>{view.description || "(no description)"}</p>
          {view.attachments?.length > 0 && <div className="mini">📎 {view.attachments.map((a) => a.file_name).join(", ")}</div>}
          <div className="callout" style={{ marginTop: 10 }}>🚫 Refused {view.declined_at} by {view.declined_by || "—"} — {view.reason || "no reason"}{view.note ? `: ${view.note}` : ""}</div>
        </Modal>
      )}
    </>
  );
}
