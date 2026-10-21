"use client";
import { useEffect, useMemo, useState } from "react";
import { Avatar, Button, ErrorState, Field, Icon, Lozenge, Modal, PageHeader, Skeleton, StaleBar, useFlags, Select } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import { invalidate } from "@/lib/api";
import * as A from "@/lib/services/admin";
import { PRIORITIES, DELIVERABLES, DELIVERABLE_OTHER_REQUIRED, deliverableOtherValue, hasOtherDeliverable, taskDeliverableLabel } from "@/lib/services/kpiActions";
import OtherTypeInput from "@/components/task/OtherTypeInput";
import { since } from "@/lib/liveTime";

/* Requests from clients waiting for an estimate and a developer, grouped by
   day › client, edited inline, then published (which fires the client
   pre-approval when that is switched on). Pre-approvals already sent are
   tracked under Settings › Pre-approvals (/kpi_task_approval/*):
   /kpi_pre_approval/* is the CLIENT's side and refuses admins. */
export default function ClientQueue() {
  const flags = useFlags();
  const queue = useResource(A.QUEUE_PATH, {}, { pollMs: 30000, ttl: 10000 });
  /* {status:false, message} (not authorized) is a failure, not an empty queue. */
  const queueErr = queue.data?.status === false ? { message: queue.data.message || queue.data.error || "Could not load the queue." } : queue.error;
  const [users, setUsers] = useState([]);
  const [edit, setEdit] = useState(null);
  const [discard, setDiscard] = useState(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [decline, setDecline] = useState(null); /* {task, mode, reasonId, docType, text, reasons} */
  useEffect(() => { A.getIntakeUsers().then(setUsers).catch(() => {}); }, []);

  const items = (queue.data?.status === false ? null : queue.data?.queue) || [];
  const groups = useMemo(() => {
    const m = new Map();
    for (const t of items) {
      const day = (t.received_at || "").slice(0, 10) || "Undated";
      const k = `${day}|${t.client_name || "—"}`;
      if (!m.has(k)) m.set(k, { day, client: t.client_name || "—", rows: [] });
      m.get(k).rows.push(t);
    }
    return [...m.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  }, [items]);
  const refresh = () => { invalidate("/kpi_pending_queue"); queue.refresh(); };

  const save = async (publish) => {
    setBusy(true);
    try {
      if (!edit.name?.trim()) throw new Error("The task needs a name.");
      if (publish && !edit.user_id) throw new Error("Pick a developer before publishing.");
      const deliverable_other = deliverableOtherValue(edit.deliverable_type, edit.deliverable_other);
      if (hasOtherDeliverable(edit.deliverable_type) && !deliverable_other) throw new Error(DELIVERABLE_OTHER_REQUIRED);
      A.assertOk(await A.saveQueueTask({ ...edit, deliverable_other }), "Could not save.");
      if (publish) { const r = await A.publishQueueTask(edit.id); A.assertOk(r, "Could not publish."); flags.ok(r.message || "Published."); }
      else flags.ok("Saved.");
      setEdit(null); refresh();
    } catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  const doDiscard = async () => {
    setBusy(true);
    try { A.assertOk(await A.discardQueueTask(discard.id, reason), "Could not discard."); flags.ok("Discarded."); setDiscard(null); setReason(""); refresh(); }
    catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  /* Decline / re-type (Odoo kpi_pending_queue.js): reasons are per mode, and a
     reason can carry the type to re-type as, which pre-selects it. */
  const loadReasons = async (mode) => {
    setDecline((d) => d && { ...d, mode, reasonId: "", docType: "", reasons: null });
    try { const reasons = await A.fetchDeclineReasons(mode); setDecline((d) => d && d.mode === mode ? { ...d, reasons } : d); }
    catch (e) { flags.err(e.message); setDecline((d) => d && { ...d, reasons: [] }); }
  };
  const openDecline = (t) => { setDecline({ task: t, mode: "decline", reasonId: "", docType: "", text: "", reasons: null }); loadReasons("decline"); };
  const pickReason = (id) => setDecline((d) => { const hit = (d.reasons || []).find((r) => String(r.id) === String(id)); return { ...d, reasonId: id, docType: hit?.target_doc_type || d.docType }; });
  const doDecline = async () => {
    const d = decline;
    if (!d.reasonId && !d.text.trim()) { flags.err("Pick a reason or type one. The client is told why."); return; }
    if (d.mode === "reclassify" && !d.docType) { flags.err("Choose what to re-type it as."); return; }
    setBusy(true);
    try {
      const r = A.assertOk(await A.declineQueueTask(d.task.id, { mode: d.mode, reasonId: d.reasonId, reasonText: d.text.trim(), docType: d.docType }), "Could not do that.");
      if (r.warning) flags.warn(r.warning, { ttl: 10000 });
      else if (r.mode === "reclassify") flags.ok(`Re-typed to ${r.external_ref} (was ${r.previous_external_ref || "no ref"}). The client has been asked to confirm.`);
      else flags.ok("Declined. The client has been told and asked to confirm.");
      setDecline(null); refresh();
    } catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  const field = { border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" };

  return (
    <>
      <PageHeader crumbs={[{ label: "Work" }, { label: "Client task queue" }]} title="Client task queue" meta="Requests from clients, waiting for an estimate and a developer">
        {queue.data && !queueErr && <span className="chip">{items.length} pending</span>}
        <a className="btn btn-ghost" href="/settings/pre-approvals">Pre-approvals</a>
      </PageHeader>
      <div className="page">
        <>
            {queueErr && (!queue.data || queue.data.status === false) && <ErrorState error={queueErr} onRetry={queue.refresh} />}
            {queue.stale && queue.data?.status !== false && <StaleBar error={queue.error} onRetry={queue.refresh} />}
            <div className="cardbox table-scroll" style={{ padding: 0 }}>
              {!queue.data && !queueErr ? <div style={{ padding: 16 }}><Skeleton rows={5} /></div> : queue.data?.status === false || !queue.data ? null : (
                <table className="table">
                  <thead><tr><th>Ref</th><th style={{ width: "30%" }}>Request</th><th>Estimate</th><th>Priority</th><th>Type</th><th>Deliverable</th><th>Developer</th><th></th></tr></thead>
                  <tbody>
                    {groups.map((g) => (
                      <GroupRows key={`${g.day}|${g.client}`} g={g} users={users} edit={edit} setEdit={setEdit} onSave={save} onDiscard={(t) => { setReason(""); setDiscard(t); }} onDecline={openDecline} busy={busy} />
                    ))}
                    {!items.length && <tr><td colSpan={8} className="empty">The queue is empty.</td></tr>}
                  </tbody>
                </table>
              )}
            </div>
            <div className="callout" style={{ background: "var(--lz-review-bg)", borderColor: "var(--tint-violet)", color: "var(--tint-violet-text)" }}><Icon n="flag" size={18} />Publishing sends a WhatsApp pre-approval to the client when "Client approval" is on in Configuration. Follow those up in Settings › Pre-approvals.</div>
        </>
      </div>
      <Modal open={!!discard} onClose={() => setDiscard(null)} title={discard ? `Discard ${discard.external_ref || "request"}?` : ""} width={460}
        footer={<><Button kind="ghost" onClick={() => setDiscard(null)}>Cancel</Button><Button kind="danger" busy={busy} onClick={doDiscard}>Discard</Button></>}>
        <p className="note" style={{ margin: 0 }}>The client is told it was not taken up. Say why. This deletes the request and its files for good; to keep it on record, use Decline / re-type instead.</p>
        <Field label="Reason"><span className="input"><input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }} /></span></Field>
      </Modal>
      <Modal open={!!decline} onClose={() => setDecline(null)} title={decline ? `Decline or re-type ${decline.task.external_ref || decline.task.name}` : ""} width={520}
        footer={<><Button kind="ghost" onClick={() => setDecline(null)}>Cancel</Button><Button kind="primary" busy={busy} onClick={doDecline}>Send to client</Button></>}>
        {decline && <>
          <p className="note" style={{ margin: 0 }}>Nothing is deleted. {decline.mode === "decline" ? "The request is archived with your reason" : "It gets a new ref and goes back into this queue"}, and the client is messaged in their own WhatsApp group and asked to confirm.</p>
          <div className="grid2">
            <Field label="What to do"><span className="input"><Select value={decline.mode} onChange={(e) => loadReasons(e.target.value)} style={field}><option value="decline">Decline it</option><option value="reclassify">Re-type it</option></Select></span></Field>
            {decline.mode === "reclassify" && <Field label="New type"><span className="input"><Select value={decline.docType} onChange={(e) => setDecline({ ...decline, docType: e.target.value })} style={field}><option value="">Choose…</option><option value="requirement">Requirement</option><option value="update">Update</option><option value="bug">Bug</option></Select></span></Field>}
          </div>
          <Field label="Reason"><span className="input"><Select value={decline.reasonId} disabled={!decline.reasons} onChange={(e) => pickReason(e.target.value)} style={field}><option value="">{decline.reasons ? "Pick a reason…" : "Loading…"}</option>{(decline.reasons || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></span></Field>
          <Field label="Message to the client" hint="Leave empty to send the reason above as written."><span className="input ta" style={{ height: "auto" }}><textarea rows={3} value={decline.text} onChange={(e) => setDecline({ ...decline, text: e.target.value })} style={{ ...field, resize: "vertical" }} /></span></Field>
        </>}
      </Modal>
    </>
  );
}

const KIND_LABEL = { requirement: "REQ", update: "UPT", bug: "BUG" };

/* Who sent it, from which project, and (when it came back) who rejected it and why. */
function Meta({ t }) {
  return (
    <div className="mini" style={{ marginTop: 4, whiteSpace: "normal" }}>
      {t.project_name && <span><Icon n="board" size={12} /> {t.project_name} · </span>}
      {t.submitted_by ? <span>by {t.submitted_by}{t.submitted_login ? ` (${t.submitted_login})` : ""} · </span> : null}
      {t.received_at ? <span title={t.received_at}>{since(t.received_at)}</span> : null}
      {t.rejected && (
        <div style={{ marginTop: 4, color: "var(--over)" }}>
          <Lozenge tone="danger">Rejected by client</Lozenge> Needs a new developer{t.reject_reason ? <>: <b>"{t.reject_reason}"</b></> : "."}
          {(t.rejected_by || t.rejected_at) && <span className="mini"> {t.rejected_by ? `by ${t.rejected_by}` : ""}{t.rejected_at ? ` · ${t.rejected_at}` : ""}</span>}
        </div>
      )}
    </div>
  );
}

function GroupRows({ g, users, edit, setEdit, onSave, onDiscard, onDecline, busy }) {
  const label = new Date(g.day + "T00:00:00").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  const sel = (v, on, opts, w) => <span className="input" style={{ height: 32, width: w }}><Select value={v ?? ""} onChange={(e) => on(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}>{opts}</Select></span>;
  return (
    <>
      <tr className="group"><td colSpan={8}>{label} · {g.client} · {g.rows.length} request{g.rows.length === 1 ? "" : "s"}</td></tr>
      {g.rows.map((t) => {
        const e = edit?.id === t.id ? edit : null;
        if (e) return (
          <tr key={t.id} className="sel" style={{ verticalAlign: "top" }}>
            <td>
              <span className="input" style={{ height: 32, width: 110 }}><input value={e.external_ref || ""} aria-label="Ref" onChange={(ev) => setEdit({ ...e, external_ref: ev.target.value })} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "var(--brand)", fontWeight: 800 }} /></span>
              <div className="mini" style={{ margin: "6px 0 3px" }}>Linked Req</div>
              {sel(e.related_req_ref || "", (v) => setEdit({ ...e, related_req_ref: v }), [<option key="" value="">None</option>, ...(t.req_options || []).map((o) => <option key={o.ref} value={o.ref}>{o.label}</option>)], 150)}
            </td>
            <td>
              <span className="input" style={{ height: 32 }}><input value={e.name || ""} aria-label="Task name" onChange={(ev) => setEdit({ ...e, name: ev.target.value })} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }} /></span>
              <span className="input ta" style={{ height: "auto", marginTop: 6 }}><textarea rows={3} value={e.description || ""} aria-label="Description" placeholder="No description was given. You can add one here." onChange={(ev) => setEdit({ ...e, description: ev.target.value })} style={{ border: 0, background: "none", outline: 0, resize: "vertical", width: "100%", font: "inherit", color: "inherit" }} /></span>
              <Meta t={t} />
            </td>
            <td><span style={{ display: "flex", gap: 4 }}><span className="input" style={{ height: 32, width: 58 }}><input type="number" min="0" value={e.estimate_hours ?? 0} onChange={(ev) => setEdit({ ...e, estimate_hours: ev.target.value })} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }} /><span className="ph">h</span></span><span className="input" style={{ height: 32, width: 64 }}><input type="number" min="0" max="59" value={e.estimate_minutes ?? 0} onChange={(ev) => setEdit({ ...e, estimate_minutes: ev.target.value })} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }} /><span className="ph">m</span></span></span></td>
            <td>{sel(e.priority || "regular", (v) => setEdit({ ...e, priority: v }), PRIORITIES.map((p) => <option key={p.code} value={p.code}>{p.label}</option>), 120)}</td>
            {/* Read-only: /kpi_pending_queue/update has no kind field; the type comes from the ref / name prefix. */}
            <td title="The type follows the request (ref / name) and cannot be changed here">{KIND_LABEL[t.kind] || "—"}</td>
            <td>{sel(e.deliverable_type || "", (v) => setEdit({ ...e, deliverable_type: v }), [<option key="" value="">—</option>, ...DELIVERABLES.map((d) => <option key={d.code} value={d.code}>{d.label}</option>)], 110)}
              {hasOtherDeliverable(e.deliverable_type) && <OtherTypeInput bare value={e.deliverable_other} onChange={(v) => setEdit({ ...e, deliverable_other: v })} style={{ height: 32, marginTop: 4, width: 160 }} />}</td>
            <td>{sel(e.user_id || "", (v) => setEdit({ ...e, user_id: v }), [<option key="" value="">Unassigned</option>, ...users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)], 160)}</td>
            <td><span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}><Button size="sm" kind="primary" busy={busy} onClick={() => onSave(true)}>Save &amp; publish</Button><Button size="sm" busy={busy} onClick={() => onSave(false)}>Save</Button><Button size="sm" kind="ghost" onClick={() => setEdit(null)}>Cancel</Button></span></td>
          </tr>
        );
        return (
          <tr key={t.id}>
            <td><span className="ref">{t.external_ref || t.ref || "—"}</span></td>
            <td style={{ whiteSpace: "normal" }}><b>{t.name}</b>{t.related_req_ref && <span className="mini"> · for {t.related_req_ref}</span>}<Meta t={t} /></td>
            <td>{t.estimate_hours || t.estimate_minutes ? `${t.estimate_hours || 0}h ${t.estimate_minutes || 0}m` : <span className="mini">not set</span>}</td>
            <td>{t.priority ? <span style={{ fontWeight: 800, color: t.priority === "urgent" ? "var(--pri-urgent)" : t.priority === "important" ? "var(--pri-important)" : "var(--pri-regular)" }}>{t.priority}</span> : <span className="mini">—</span>}</td>
            <td>{KIND_LABEL[t.kind] || "—"}</td>
            <td>{t.deliverable_type ? taskDeliverableLabel(t) : <span className="mini">—</span>}</td>
            <td>{t.user_name ? <><Avatar name={t.user_name} uid={t.user_id} size={22} /> {t.user_name}</> : <span className="mini">unassigned</span>}</td>
            <td><span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}><Button size="sm" onClick={() => setEdit({ ...t })}>Edit</Button><Button size="sm" kind="ghost" title="Decline it or re-type it, with a reason the client is told" onClick={() => onDecline(t)}>Decline / re-type</Button><Button size="sm" kind="ghost" onClick={() => onDiscard(t)}>Discard</Button></span></td>
          </tr>
        );
      })}
    </>
  );
}
