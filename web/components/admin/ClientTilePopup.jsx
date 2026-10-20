"use client";
/* Dashboard › Client details: a tile's popup — the rows behind its number
   (/kpi_owner/client_summary_items, the same rule as the count), plus the
   button(s) to the page where that work is actually handled. A task row opens
   the task on the board; an invoice row opens the invoice. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Avatar, Button, Lozenge, Modal, Skeleton, stateTone } from "@/components/ui";
import * as A from "@/lib/services/admin";

const dmy = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");

/* Title, what the list is, and where to go from here. */
export const TILE = {
  open: { title: "Open requests", note: "Every task for this client that is not completed. “New” ones still need an estimate in the Client Task Queue.",
    go: [{ href: "/queue", label: "Open Client Task Queue", primary: true }, { href: "/board", label: "Open board" }] },
  in_progress: { title: "In progress", note: "Tasks being worked on now (running or paused).",
    go: [{ href: "/board", label: "Open board", primary: true }, { href: "/people", label: "Live Tracking" }] },
  waiting: { title: "Waiting sign-off", note: "Delivered work the client has not approved yet.",
    go: [{ href: "/intake/certificates", label: "Open Completion Certificates", primary: true }, { href: "/approvals", label: "Approvals" }] },
  certified: { title: "Certified", note: "Tasks the client signed off in this period.",
    go: [{ href: "/intake/certificates", label: "Open Completion Certificates", primary: true }, { href: "/dashboards", label: "Client Billing" }] },
  hours: { title: "Hours used", note: "Time logged in this period, per task and person, against each task's quote.",
    go: [{ href: "/reports/work", label: "Open Work Report", primary: true }, { href: "/dashboards", label: "Client Billing" }] },
  billing: { title: "Billing", note: "This client's invoices, newest first.",
    go: [{ href: "/reports/invoices", label: "Open Client Invoices", primary: true }, { href: "/dashboards", label: "Client Billing" }] },
};

export default function ClientTilePopup({ kind, client, range, period, onClose }) {
  const t = TILE[kind];
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let gone = false;
    A.fetchClientItems(client.id, kind, range?.[0], range?.[1])
      .then((r) => { if (gone) return; if (r?.status === false) setErr(r.message || "Could not load."); else setRows(r.rows || []); })
      .catch((e) => { if (!gone) setErr(e.message); });
    return () => { gone = true; };
  }, [client.id, kind, range?.[0], range?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal open onClose={onClose} width={860}
      title={<span className="ep-title">{t.title}{rows ? ` (${rows.length})` : ""}<small>{client.name} · {period}</small></span>}
      footer={<>
        {t.go.map((g) => (
          <Link key={g.href} href={g.href} className={`btn ${g.primary ? "btn-primary" : "btn-ghost"}`} style={{ textDecoration: "none" }}>{g.label} →</Link>
        ))}
        <Button onClick={onClose}>Close</Button>
      </>}>
      <p className="mini" style={{ margin: "0 0 10px" }}>{t.note}</p>
      {err && <div className="callout danger">{err}</div>}
      {!rows && !err && <Skeleton rows={5} />}
      {rows && !rows.length && <div className="d3-empty">Nothing here for this {kind === "open" || kind === "in_progress" || kind === "waiting" ? "client right now" : "period"}.</div>}
      {rows && rows.length > 0 && (
        <div className="table-scroll" style={{ maxHeight: 440 }}>
          {kind === "billing" ? <Invoices rows={rows} /> : kind === "hours" ? <Hours rows={rows} /> : <Tasks rows={rows} kind={kind} />}
        </div>
      )}
    </Modal>
  );
}

function Tasks({ rows, kind }) {
  return (
    <table className="table">
      <thead><tr><th>Ref</th><th>Task</th><th>Project</th><th>Assignee</th><th>State</th><th>{kind === "certified" ? "Signed" : "Deadline"}</th></tr></thead>
      <tbody>
        {rows.map((r) => {
          const [tone, label] = stateTone(r.state);
          return (
            <tr key={r.id}>
              <td><span className="ref">{r.ref || `#${r.id}`}</span></td>
              <td style={{ whiteSpace: "normal" }}><Link href={`/board?task=${r.id}`}>{r.name}</Link>{r.is_new && <> <Lozenge tone="fresh" style={{ textTransform: "none" }}>New · needs estimate</Lozenge></>}</td>
              <td className="mini">{r.project || "—"}</td>
              <td>{r.assignee ? <><Avatar name={r.assignee} uid={r.assignee_id} size={20} />{r.assignee}</> : <span className="mini">Unassigned</span>}</td>
              <td><Lozenge tone={tone} style={{ textTransform: "none" }} title={r.state_label}>{label}</Lozenge></td>
              <td className="mini">{kind === "certified" ? r.signed : r.deadline ? dmy(r.deadline) : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Hours({ rows }) {
  const total = rows.reduce((s, r) => s + r.hours, 0);
  return (
    <table className="table">
      <thead><tr><th>Ref</th><th>Task</th><th>Person</th><th className="num">Hours</th><th className="num">Quote</th></tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.id}-${r.person_id}-${i}`}>
            <td><span className="ref">{r.ref || `#${r.id}`}</span></td>
            <td style={{ whiteSpace: "normal" }}><Link href={`/board?task=${r.id}`}>{r.name}</Link><small className="mini" style={{ display: "block" }}>{r.project}</small></td>
            <td>{r.person ? <><Avatar name={r.person} uid={r.person_id} size={20} />{r.person}</> : "—"}</td>
            <td className={`num ${r.quoted_h && r.hours > r.quoted_h ? "d3-bad" : ""}`}>{r.hours.toFixed(1)}h</td>
            <td className="num mini">{r.quoted_h ? `${r.quoted_h}h` : "—"}</td>
          </tr>
        ))}
        <tr><td colSpan={3}><b>Total</b></td><td className="num"><b>{total.toFixed(1)}h</b></td><td /></tr>
      </tbody>
    </table>
  );
}

function Invoices({ rows }) {
  return (
    <table className="table">
      <thead><tr><th>Invoice</th><th>Date</th><th>Status</th><th>Payment</th><th className="num">Amount</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td><Link href={`/reports/invoices/${r.id}`}><b>{r.name}</b></Link></td>
            <td className="mini">{dmy(r.date)}</td>
            <td><Lozenge tone={r.state === "draft" ? "todo" : r.state === "sent" ? "progress" : "review"} style={{ textTransform: "none" }}>{{ draft: "Draft", finalized: "Finalized", sent: "Sent" }[r.state] || r.state}</Lozenge></td>
            <td>{r.payment_status === "paid" ? <Lozenge tone="done" style={{ textTransform: "none" }}>Paid</Lozenge> : <Lozenge tone="danger" style={{ textTransform: "none" }}>Unpaid</Lozenge>}</td>
            <td className="num">{r.currency}{Number(r.amount).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
