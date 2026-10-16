"use client";
import { useState } from "react";
import { Avatar, Button, ErrorState, Icon, Input, Lozenge, Modal, PageHeader, Skeleton, StaleBar, Tabs, stateTone, useFlags } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import { invalidate } from "@/lib/api";
import * as A from "@/lib/services/admin";
import { useTaskActions } from "@/components/task/TaskActions";
import SettingsNav from "./SettingsNav";

/* Client pre-approval status (/kpi_task_approval/*): tasks a developer has
   started without the client's approval — send the approval request by hand
   (one client at a time, the next one not yet asked; wraps to the first when
   all were tried), or choose which client users the KRA has when it has none —
   and, for reference, the started tasks the client did approve. */
const when = (iso) => { if (!iso) return "—"; const t = new Date(/([zZ]|[+-]\d\d:?\d\d)$/.test(iso) ? iso : iso + "Z"); /* naive UTC from Odoo */ return Number.isNaN(+t) ? iso.slice(0, 16).replace("T", " ") : t.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); };

export default function PreApprovals() {
  const flags = useFlags();
  const acts = useTaskActions();
  const [tab, setTab] = useState("pending");
  const list = useResource(A.TASK_APPROVAL_PATH, {}, { pollMs: 60000, ttl: 10000 });
  const refused = list.data?.status === false;
  const pending = list.data?.unapproved_started || [];
  const approved = list.data?.approved_started || [];
  const [sending, setSending] = useState(null);
  const [picker, setPicker] = useState(null);
  const reload = () => { invalidate("/kpi_task_approval"); list.refresh(); };

  const send = async (t) => {
    setSending(t.id);
    try { const r = A.assertOk(await A.resendTaskApproval(t.id), "Could not send."); flags.ok(r.message || "Sent."); reload(); }
    catch (e) { flags.err(e.message); } finally { setSending(null); }
  };
  const open = (id) => (e) => { e.preventDefault(); acts.openTask(id); };

  return (
    <>
      <PageHeader crumbs={[{ label: "Settings" }, { label: "Pre-approvals" }]} title="Client pre-approvals" meta="Started work and whether the client approved it">
        <Tabs items={[{ key: "pending", label: "Not approved", count: list.data ? pending.length : undefined }, { key: "approved", label: "Approved", count: list.data ? approved.length : undefined }]} value={tab} onChange={setTab} />
        <Button kind="ghost" icon="swap" onClick={reload}>Refresh</Button>
      </PageHeader>
      <SettingsNav />
      <div className="page">
        {refused && <ErrorState error={{ message: list.data.message }} onRetry={reload} />}
        {list.error && !list.data && <ErrorState error={list.error} onRetry={reload} />}
        {list.stale && <StaleBar error={list.error} onRetry={reload} />}
        {tab === "pending" && <div className="callout warn"><Icon n="warn" size={18} /><span>A developer is working on these but the client has not approved yet. "Send request" WhatsApps the next client user who has not been asked; when all were asked it starts again from the first.</span></div>}
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {!list.data && !list.error ? <div style={{ padding: 16 }}><Skeleton rows={6} /></div> : tab === "pending" ? (
            <table className="table">
              <thead><tr><th>Ref</th><th>Task</th><th>Client / KRA</th><th>Developer</th><th>State</th><th>Last asked</th><th>Next</th><th></th></tr></thead>
              <tbody>
                {pending.map((t) => {
                  const [tone, label] = stateTone(t.task_state);
                  return (
                    <tr key={t.id}>
                      <td><span className="ref">{t.external_ref || `#${t.id}`}</span></td>
                      <td style={{ whiteSpace: "normal", minWidth: 200 }}><a href={`/board?task=${t.id}`} onClick={open(t.id)}>{t.name}</a></td>
                      <td style={{ whiteSpace: "normal" }}>{t.client_name}<div className="mini">{t.kra_name}</div></td>
                      <td>{t.developer}</td>
                      <td><Lozenge tone={tone}>{label}</Lozenge></td>
                      <td>{t.current_client ? <>{t.current_client}<div className="mini">{t.notified_count} of {t.total_clients} asked</div></> : <span className="mini">nobody yet</span>}</td>
                      <td>{t.total_clients === 0 ? <Lozenge tone="danger" style={{ textTransform: "none" }}>No client users</Lozenge> : t.next_client ? <Lozenge tone="review" style={{ textTransform: "none" }}>{t.next_client}</Lozenge> : <span className="mini">all asked — wraps</span>}</td>
                      <td><span style={{ display: "inline-flex", gap: 6 }}>
                        <Button size="sm" kind={t.total_clients === 0 ? "primary" : "ghost"} icon="people" onClick={() => setPicker(t)}>{t.total_clients === 0 ? "Choose clients" : "Clients"}</Button>
                        <Button size="sm" kind="danger" busy={sending === t.id} disabled={t.total_clients === 0} onClick={() => send(t)}>Send request</Button>
                      </span></td>
                    </tr>
                  );
                })}
                {!pending.length && <tr><td colSpan={8} className="empty">Every started task is approved. Nothing to send.</td></tr>}
              </tbody>
            </table>
          ) : (
            <table className="table">
              <thead><tr><th>Ref</th><th>Task</th><th>Client / KRA</th><th>Developer</th><th>State</th><th>Decided by</th><th>Approved</th></tr></thead>
              <tbody>
                {approved.map((t) => {
                  const [tone, label] = stateTone(t.task_state);
                  return (
                    <tr key={t.id}>
                      <td><span className="ref">{t.external_ref || `#${t.id}`}</span></td>
                      <td style={{ whiteSpace: "normal", minWidth: 200 }}><a href={`/board?task=${t.id}`} onClick={open(t.id)}>{t.name}</a></td>
                      <td style={{ whiteSpace: "normal" }}>{t.client_name}<div className="mini">{t.kra_name}</div></td>
                      <td>{t.developer}</td>
                      <td><Lozenge tone={tone}>{label}</Lozenge></td>
                      <td>{t.decided_by || <span className="mini">—</span>}</td>
                      <td className="mini">{when(t.approval_date)}</td>
                    </tr>
                  );
                })}
                {!approved.length && <tr><td colSpan={7} className="empty">No approved, started tasks.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {picker && <ClientPicker task={picker} flags={flags} onClose={() => setPicker(null)} onSaved={() => { setPicker(null); reload(); }} />}
    </>
  );
}

/* Replaces the client users of the task's KRA and restarts the task's
   escalation from the first of them. */
function ClientPicker({ task, flags, onClose, onSaved }) {
  const list = useResource("/kpi_task_approval/get_available_clients", {}, { ttl: 30000 });
  const clients = list.data?.clients || [];
  const [picked, setPicked] = useState(() => new Set());
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const shown = clients.filter((c) => !q || `${c.name} ${c.login} ${c.phone}`.toLowerCase().includes(q.toLowerCase()));
  const save = async () => {
    setBusy(true);
    try { const r = A.assertOk(await A.setTaskKraClients(task.id, [...picked]), "Could not save."); flags.ok(r.message || "Clients saved."); onSaved(); }
    catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Client users for ${task.client_name || task.kra_name}`} width={520}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} disabled={!picked.size} onClick={save}>Save {picked.size || ""}</Button></>}>
      <p className="note" style={{ margin: 0 }}>Who receives the pre-approval WhatsApp for tasks under <b>{task.kra_name}</b>. This replaces the KRA's current client users. New client logins are made in Settings › KRA / KPI master (Client users).</p>
      <Input icon="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a client user" />
      <div className="people" style={{ maxHeight: 320, overflow: "auto" }}>
        {list.data?.status === false && <span className="mini" style={{ padding: 8, color: "var(--danger)" }}>{list.data.message}</span>}
        {!list.data && !list.error && <span className="mini" style={{ padding: 8 }}>Loading…</span>}
        {list.error && <span className="mini" style={{ padding: 8, color: "var(--danger)" }}>{list.error.message}</span>}
        {shown.map((u) => <label key={u.id}><input type="checkbox" checked={picked.has(u.id)} onChange={(e) => setPicked((s) => { const n = new Set(s); e.target.checked ? n.add(u.id) : n.delete(u.id); return n; })} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} /><Avatar name={u.name} id={u.id} size={22} />{u.name}<span className="mini" style={{ marginLeft: "auto" }}>{u.phone || u.login}</span></label>)}
        {list.data && !shown.length && list.data.status !== false && <span className="mini" style={{ padding: 8 }}>No client users{q ? " match" : " yet"}.</span>}
      </div>
    </Modal>
  );
}
