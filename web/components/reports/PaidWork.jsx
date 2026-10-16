"use client";
import { useMemo, useState } from "react";
import { Avatar, Button, ErrorState, Icon, PageHeader, Skeleton } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import * as R from "@/lib/services/reports";
import { fmtHM, estimateSeconds } from "@/lib/services/kpiActions";
import ReportsNav from "./ReportsNav";

/* Settled work — tasks on invoices marked paid (archived off the board). */
export default function PaidWork() {
  const paid = useResource("/kra_kpi/tasks/paid", {}, { ttl: 60000 });
  const [q, setQ] = useState("");
  /* {status:false, message} is a refusal, not data. */
  const paidData = paid.data?.status === false ? null : paid.data;
  const paidErr = paid.error || (paid.data?.status === false ? new Error(paid.data.message || "Could not load paid work.") : null);
  const tasks = useMemo(() => (paidData?.tasks || []).filter((t) => !q || `${t.external_ref} ${t.name} ${t.user_name} ${t.client_name} ${t.invoice_name}`.toLowerCase().includes(q.toLowerCase())), [paid.data, q]);
  const hours = tasks.reduce((s, t) => s + (t.timer_total_seconds || 0), 0);
  const exportCsv = () => R.downloadText(R.csv(tasks, [{ key: "external_ref", label: "Ref" }, { key: "name", label: "Task" }, { key: "user_name", label: "Developer" }, { key: "client_name", label: "Client" }, { label: "Estimate", get: (t) => fmtHM(estimateSeconds(t)) }, { label: "Spent", get: (t) => fmtHM(t.timer_total_seconds) }, { key: "invoice_name", label: "Invoice" }, { key: "paid_on", label: "Paid on" }]), "paid-work.csv");

  return (
    <>
      <PageHeader crumbs={[{ label: "Reports" }, { label: "Paid work" }]} title="Paid work" meta="Tasks settled on a paid invoice">
        <label className="search" style={{ margin: 0, width: 220 }}><Icon n="search" size={16} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search" style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", width: "100%" }} /></label>
        <Button icon="download" onClick={exportCsv} disabled={!tasks.length}>CSV</Button>
      </PageHeader>
      <div className="page">
        <ReportsNav />
        <div className="stats">
          <div className="stat"><small>Paid tasks</small><b>{paidData ? tasks.length : "…"}</b><span>{paidData?.truncated ? "showing the latest 200" : "all time"}</span></div>
          <div className="stat"><small>Hours billed</small><b>{paidData ? fmtHM(hours) : "…"}</b><span>time logged on them</span></div>
          <div className="stat"><small>Invoices</small><b>{paidData ? new Set(tasks.map((t) => t.invoice_name || t.invoice_id)).size : "…"}</b><span>settled</span></div>
          <div className="stat"><small>Clients</small><b>{paidData ? new Set(tasks.map((t) => t.client_name)).size : "…"}</b><span>with paid work</span></div>
        </div>
        {paidErr && !paidData && <ErrorState error={paidErr} onRetry={paid.refresh} />}
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {!paidData && !paidErr ? <div style={{ padding: 16 }}><Skeleton rows={6} /></div> : !paidData ? null : (
            <table className="table">
              <thead><tr><th>Ref</th><th>Task</th><th>Developer</th><th>Client / project</th><th className="num">Estimate</th><th className="num">Spent</th><th>Invoice</th><th>Paid on</th></tr></thead>
              <tbody>{tasks.map((t) => (
                <tr key={t.id}><td><span className="ref">{t.external_ref || `#${t.id}`}</span></td><td><b>{t.name}</b></td><td>{t.user_name ? <><Avatar name={t.user_name} id={t.user_id} size={22} /> {t.user_name}</> : "—"}</td><td>{t.client_name || "—"}{t.project_name ? ` · ${t.project_name}` : ""}</td><td className="num">{fmtHM(estimateSeconds(t))}</td><td className="num">{fmtHM(t.timer_total_seconds)}</td><td><b>{t.invoice_name || t.invoice || "—"}</b></td><td>{t.paid_on || t.payment_date || "—"}</td></tr>
              ))}{paid.data && !tasks.length && <tr><td colSpan={8} className="empty">No paid work yet.</td></tr>}</tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
