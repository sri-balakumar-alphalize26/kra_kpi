"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ErrorState, Field, Icon, Input, Lozenge, Modal, PageHeader, Select, Skeleton, useFlags } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import * as A from "@/lib/services/admin";

/* One card per client: certified / awaiting / in progress, actual vs quoted
   hours, last invoice, and the per-project breakdown with "Invoice this
   project". "Certified tasks" popup (filter, hours totals, Generate invoice)
   and "Create invoice". Owners and System only (dashboards/layout.jsx). */
export default function OwnerDashboard() {
  const flags = useFlags();
  const router = useRouter();
  const dash = useResource(A.CERTIFIED_PATH, {}, { ttl: 30000 });
  /* {status:false, message} (not authorized) is a failure, not "no clients". */
  const refused = dash.data?.status === false ? { message: dash.data.message || dash.data.error || "Could not load the dashboard." } : null;
  const data = refused ? null : dash.data;
  const clients = data?.clients || [];
  const [tasks, setTasks] = useState(null); /* { client, rows } */
  const [inv, setInv] = useState(null);    /* { ...client, project? } */
  const [only, setOnly] = useState("");     /* client filter */
  const [openProj, setOpenProj] = useState(() => new Set());
  const [tq, setTq] = useState("");
  const [range, setRange] = useState({ from: "", to: "" });
  const [busy, setBusy] = useState(false);
  const sum = (k) => clients.reduce((s, c) => s + (c[k] || 0), 0);

  const showTasks = async (c) => {
    setTasks({ client: c, rows: null }); setTq("");
    try { const r = A.assertOk(await A.fetchClientCertifiedTasks(c.client_id), "Could not load the certified tasks."); setTasks({ client: c, rows: r.tasks || [] }); } catch (e) { flags.err(e.message); setTasks(null); }
  };
  const makeInvoice = async () => {
    setBusy(true);
    try {
      const r = await A.createInvoice({ clientKraId: inv.client_id, subKraIds: inv.project ? [inv.project.project_id] : [], fromDate: range.from, toDate: range.to });
      A.assertOk(r, "Could not create the invoice.");
      flags.ok(r.data?.name ? `Invoice ${r.data.name} created.` : "Invoice created.");
      setInv(null); router.push(r.invoice_id ? `/reports/invoices/${r.invoice_id}` : "/reports/invoices");
    } catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  const shownClients = only ? clients.filter((c) => String(c.client_id) === only) : clients;
  const ql = tq.trim().toLowerCase();
  const shownTasks = (tasks?.rows || []).filter((t) => !ql || [t.name, t.external_ref, t.primary_assignee, t.client_signed_by].some((v) => (v || "").toLowerCase().includes(ql)));
  const hrs = (k) => shownTasks.reduce((s, t) => s + (Number(t[k]) || 0), 0).toFixed(2);
  const toggleProj = (id) => setOpenProj((x) => { const n = new Set(x); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const invTone = (s) => (/paid/.test(s || "") ? "done" : /sent|final/.test(s || "") ? "progress" : /claim/.test(s || "") ? "review" : "todo");

  return (
    <>
      <PageHeader crumbs={[{ label: "Dashboards" }, { label: "Owner dashboard" }]} title="Owner dashboard">
        {clients.length > 1 && <span className="input" style={{ height: 32, minWidth: 200 }}><Icon n="filter" size={14} /><Select value={only} onChange={(e) => setOnly(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}><option value="">All clients ({clients.length})</option>{clients.map((c) => <option key={c.client_id} value={c.client_id}>{c.client_name}</option>)}</Select></span>}
        <Button icon="swap" kind="ghost" onClick={dash.refresh}>Refresh</Button>
        <Button onClick={() => router.push("/reports/invoices")}>All invoices</Button>
      </PageHeader>
      <div className="page">
        <div className="stats s5">
          <div className="stat"><small>Clients</small><b>{data ? clients.length : "…"}</b><span>{data ? `${clients.reduce((s, c) => s + (c.projects?.length || 0), 0)} projects` : ""}</span></div>
          <div className="stat"><small>Certified</small><b style={{ color: "var(--pri-regular)" }}>{data ? sum("completed_count") : "…"}</b><span>signed off by clients</span></div>
          <div className="stat"><small>Awaiting sign-off</small><b style={{ color: "var(--tint-violet)" }}>{data ? sum("awaiting_client_count") : "…"}</b><span>with the client</span></div>
          <div className="stat"><small>In progress</small><b style={{ color: "var(--tint-blue)" }}>{data ? sum("in_progress_count") : "…"}</b><span>being built</span></div>
          <div className="stat"><small>Hours</small><b>{data ? `${Math.round(sum("total_actual_hours"))}h` : "…"}</b><span>actual · quoted {data ? `${Math.round(sum("total_quoted_hours"))}h` : ""}</span></div>
        </div>
        {(refused || (dash.error && !dash.data)) && <ErrorState error={refused || dash.error} onRetry={dash.refresh} />}
        {!dash.data && !dash.error && <div className="stats">{[1, 2, 3, 4].map((i) => <div key={i} className="cardbox"><Skeleton rows={4} /></div>)}</div>}
        <div className="stats">
          {shownClients.map((c) => {
            const over = c.total_quoted_hours > 0 && c.total_actual_hours > c.total_quoted_hours;
            return (
              <div key={c.client_id} className="cardbox" style={{ gap: 10 }}>
                <h2><span className="proj-tile" style={{ width: 28, height: 28, fontSize: 11, background: "var(--proj)" }}>{(c.client_name || "?").slice(0, 2).toUpperCase()}</span>{c.client_name}{c.parent_name ? <small>· {c.parent_name}</small> : null}</h2>
                <div className="row" style={{ gap: 14 }}><span><b style={{ fontSize: 22, color: "var(--navy)" }}>{c.completed_count || 0}</b> <span className="mini">certified</span></span><span><b style={{ fontSize: 22, color: "var(--tint-violet)" }}>{c.awaiting_client_count || 0}</b> <span className="mini">awaiting</span></span><span><b style={{ fontSize: 22, color: "var(--tint-blue)" }}>{c.in_progress_count || 0}</b> <span className="mini">in progress</span></span></div>
                <div className="kv" style={{ padding: "6px 0" }}><span className="lbl" style={{ minWidth: 0 }}>Actual vs quoted</span><span className="val">{Math.round(c.total_actual_hours || 0)}h / {Math.round(c.total_quoted_hours || 0)}h</span><span className="prog"><i style={{ width: `${c.total_quoted_hours ? Math.min(100, (c.total_actual_hours / c.total_quoted_hours) * 100) : 0}%`, background: over ? "var(--pri-important)" : "var(--pri-regular)" }} /></span></div>
                <div className="kv" style={{ padding: "6px 0", border: 0 }}><span className="lbl" style={{ minWidth: 0 }}>Last invoice</span>{c.last_invoice_name ? <span className="val">{c.last_invoice_name} <Lozenge tone={invTone(c.last_invoice_state)}>{c.last_invoice_state}</Lozenge> <span className="mini">{c.last_invoice_date}</span></span> : <span className="mini">none yet</span>}</div>
                {c.projects?.length > 0 && (
                  <div>
                    <button type="button" onClick={() => toggleProj(c.client_id)} aria-expanded={openProj.has(c.client_id)} style={{ border: 0, background: "none", padding: 0, cursor: "pointer", font: "inherit", fontWeight: 700, color: "var(--brand)", display: "inline-flex", alignItems: "center", gap: 4 }}><Icon n={openProj.has(c.client_id) ? "chev" : "cright"} size={14} />Projects ({c.projects.length})</button>
                    {openProj.has(c.client_id) && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
                        {c.projects.map((p) => (
                          <div key={p.project_id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 8px", borderRadius: 8, background: "var(--hover)" }}>
                            <span style={{ flex: 1, minWidth: 0 }}>
                              <b style={{ display: "block", fontSize: 13 }}>{p.project_name}</b>
                              <span className="mini">{p.completed_count || 0} certified · {p.awaiting_client_count || 0} awaiting · {p.in_progress_count || 0} active · actual {p.total_actual_hours || 0}h / quoted {p.total_quoted_hours || 0}h</span>
                            </span>
                            <Button size="sm" disabled={!p.completed_count} title={p.completed_count ? "Invoice this project" : "No certified tasks for this project"} onClick={() => { setRange({ from: "", to: "" }); setInv({ ...c, project: p }); }}>Invoice this project</Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div className="row"><Button size="sm" onClick={() => showTasks(c)}>Certified tasks</Button><Button size="sm" kind="primary" disabled={!c.completed_count} onClick={() => { setRange({ from: "", to: "" }); setInv(c); }}>Create invoice</Button></div>
              </div>
            );
          })}
        </div>
        {data && clients.length > 0 && !shownClients.length && <div className="cardbox"><span className="mini">No client matches the filter.</span></div>}
        {data && !clients.length && <div className="cardbox"><span className="mini">No clients yet — create one in Settings › KRA / KPI master.</span></div>}
      </div>
      <Modal open={!!tasks} onClose={() => setTasks(null)} title={tasks ? `Certified · ${tasks.client.client_name}` : ""} width={860}
        footer={tasks && <><Button kind="ghost" onClick={() => setTasks(null)}>Close</Button><Button kind="primary" disabled={!tasks.rows?.length} onClick={() => { const c = tasks.client; setTasks(null); setRange({ from: "", to: "" }); setInv(c); }}>Generate invoice</Button></>}>
        {tasks && tasks.rows?.length > 0 && <Input icon="search" value={tq} onChange={(e) => setTq(e.target.value)} placeholder="Filter by task, ref, developer…" style={{ maxWidth: 360 }} />}
        {tasks && (tasks.rows == null ? <Skeleton rows={5} /> : (
          <table className="table"><thead><tr><th>Ref</th><th>Task</th><th>Developer</th><th>Signed by</th><th>Date</th><th className="num">Actual</th><th className="num">Quoted</th></tr></thead>
            <tbody>{shownTasks.map((t) => <tr key={t.id}><td><span className="ref">{t.external_ref || `#${t.id}`}</span></td><td><b>{t.name}</b></td><td>{t.primary_assignee || "—"}</td><td>{t.client_signed_by || "—"}</td><td>{t.signed_date || t.completion_date || ""}</td><td className="num">{t.actual_hours}h</td><td className="num">{t.quoted_hours}h</td></tr>)}{!shownTasks.length && <tr><td colSpan={7} className="empty">{tasks.rows.length ? "No tasks match the filter." : "No certified tasks."}</td></tr>}</tbody>
            {shownTasks.length > 0 && <tfoot><tr><th colSpan={5} style={{ textAlign: "right" }}>Total{ql ? " (filtered)" : ""}</th><th className="num">{hrs("actual_hours")}h</th><th className="num">{hrs("quoted_hours")}h</th></tr></tfoot>}</table>
        ))}
      </Modal>
      <Modal open={!!inv} onClose={() => setInv(null)} title={inv ? `Create invoice · ${inv.client_name}${inv.project ? ` › ${inv.project.project_name}` : ""}` : ""} width={480}
        footer={<><Button kind="ghost" onClick={() => setInv(null)}>Cancel</Button><Button kind="primary" busy={busy} onClick={makeInvoice}>Create draft</Button></>}>
        <p className="note" style={{ margin: 0 }}>Certified tasks{inv?.project ? ` of ${inv.project.project_name}` : ""} not yet on an invoice become its lines. Leave the dates empty for all of them.</p>
        <div className="grid2"><Field label="From"><span className="input"><input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }} /></span></Field><Field label="To"><span className="input"><input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }} /></span></Field></div>
      </Modal>
    </>
  );
}
