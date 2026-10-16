"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ErrorState, Field, Lozenge, Modal, PageHeader, Skeleton, Tabs, useFlags, Select } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import { invalidate } from "@/lib/api";
import * as P from "@/lib/services/portal";
import { downloadB64, invSymbol, lineAmount } from "@/lib/services/reports";

/* Invoices as the client sees them: list, detail, PDF, "Mark as paid" claim. */
export default function PortalInvoices({ id }) {
  const router = useRouter();
  const flags = useFlags();
  const [tab, setTab] = useState("all");
  const list = useResource(P.INVOICES_PATH, { status_filter: tab }, { ttl: 15000 });
  const invoices = list.data?.invoices || [];
  const counts = list.data?.counts || {};
  const [detail, setDetail] = useState(null);
  const [claim, setClaim] = useState(null); const [method, setMethod] = useState("bank_transfer"); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { if (id) P.fetchInvoice(id).then((d) => setDetail(d || { missing: true })); }, [id]);
  const open = (inv) => router.push(`/portal/invoices/${inv.id}`);
  const close = () => { setDetail(null); router.push("/portal/invoices"); };
  const openSum = invoices.filter((i) => i.payment_status !== "paid" && i.state !== "draft").reduce((s, i) => s + (i.total_amount || 0), 0);
  const paidSum = invoices.filter((i) => i.payment_status === "paid").reduce((s, i) => s + (i.total_amount || 0), 0);
  /* One symbol for the summary tiles when every invoice shares a currency. */
  const syms = [...new Set(invoices.map((i) => invSymbol(i)))];
  const listSym = syms.length === 1 ? syms[0] : "₹";
  const listFailed = list.data?.status === false;
  const listErr = list.error || (listFailed ? new Error(list.data.message || "Could not load your invoices.") : null);
  const [pdfBusy, setPdfBusy] = useState(0);
  const pdf = async (inv) => {
    setPdfBusy(inv.id);
    try { const r = P.assertOk(await P.invoicePdf(inv.id), "Could not build the PDF."); downloadB64(r.data_b64, r.file_name || `${inv.name || "Invoice"}.pdf`, r.mimetype || "application/pdf"); }
    catch (e) { flags.err(e.message); } finally { setPdfBusy(0); }
  };
  const doClaim = async () => {
    setBusy(true);
    try { P.assertOk(await P.clientMarkPaid(claim.id, method, note), "Could not record that."); flags.ok("Thanks — the team will confirm the payment."); setClaim(null); invalidate("/kpi_client_invoice"); list.refresh(); if (detail) setDetail(await P.fetchInvoice(detail.id)); }
    catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader crumbs={[{ label: "Portal", href: "/portal" }, { label: "Invoices" }]} title="Invoices">
        <Tabs items={[{ key: "all", label: "All", count: counts.all }, { key: "due", label: "Open", count: counts.due }, { key: "claimed", label: "Claimed", count: counts.claimed }, { key: "paid", label: "Paid", count: counts.paid }]} value={tab} onChange={setTab} />
      </PageHeader>
      <div className="page" style={{ maxWidth: 1180 }}>
        <div className="stats">
          <div className="stat"><small>Open</small><b style={{ color: "var(--pri-important)" }}>{list.data ? P.money(openSum, listSym) : "…"}</b><span>{invoices.filter((i) => i.payment_status !== "paid" && i.state !== "draft").length} invoice(s)</span></div>
          <div className="stat"><small>Paid</small><b>{list.data ? P.money(paidSum, listSym) : "…"}</b><span>{invoices.filter((i) => i.payment_status === "paid").length} invoice(s)</span></div>
          <div className="stat"><small>Hours billed</small><b>{list.data ? `${Math.round(invoices.reduce((s, i) => s + (i.grand_total_hours || 0), 0))}h` : "…"}</b><span>across all invoices</span></div>
          <div className="stat"><small>Latest</small><b style={{ fontSize: 18 }}>{invoices[0]?.name || "—"}</b><span>{invoices[0]?.invoice_date || ""}</span></div>
        </div>
        {listErr && (!list.data || listFailed) && <ErrorState error={listErr} onRetry={list.refresh} />}
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {!list.data && !listErr ? <div style={{ padding: 16 }}><Skeleton rows={5} /></div> : listFailed ? null : (
            <table className="table">
              <thead><tr><th>Invoice</th><th>Title</th><th>Period</th><th className="num">Hours</th><th className="num">Amount</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {invoices.filter((i) => i.state !== "draft").map((inv) => (
                  <tr key={inv.id} style={{ cursor: "pointer" }} onClick={() => open(inv)}>
                    <td><b>{inv.name}</b></td><td>{inv.invoice_title || "—"}</td><td>{inv.from_date} – {inv.to_date}</td><td className="num">{inv.grand_total_hours ?? inv.total_actual_hours}h</td><td className="num"><b>{P.money(inv.total_amount, invSymbol(inv))}</b></td>
                    <td><Lozenge tone={P.invoiceTone(inv)}>{P.invoiceLabel(inv)}</Lozenge>{inv.unpaid_reason && <div className="mini" style={{ color: "var(--danger)" }} title={inv.unpaid_reason}>↺ Payment reversed</div>}</td>
                    <td><span style={{ display: "inline-flex", gap: 6 }}><Button size="sm" onClick={(e) => { e.stopPropagation(); open(inv); }}>View</Button><Button size="sm" kind="ghost" icon="download" busy={pdfBusy === inv.id} onClick={(e) => { e.stopPropagation(); pdf(inv); }}>PDF</Button>{inv.payment_status !== "paid" && !inv.client_paid_claim && inv.state !== "draft" && <Button size="sm" kind="primary" onClick={(e) => { e.stopPropagation(); setNote(""); setClaim(inv); }}>Mark as paid</Button>}</span></td>
                  </tr>
                ))}
                {list.data && !invoices.filter((i) => i.state !== "draft").length && <tr><td colSpan={7} className="empty">No invoices yet.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
        <p className="mini" style={{ margin: 0 }}>"Mark as paid" tells the team you've transferred the amount; the invoice shows as paid once they confirm.</p>
      </div>
      <Modal open={!!id} onClose={close} title={detail?.name || "Invoice"} width={760}
        footer={detail && !detail.missing ? <><Button icon="download" busy={pdfBusy === detail.id} onClick={() => pdf(detail)}>Download PDF</Button>{detail.payment_status !== "paid" && !detail.client_paid_claim && <Button kind="primary" onClick={() => { setNote(""); setClaim(detail); }}>Mark as paid</Button>}<Button kind="ghost" onClick={close}>Close</Button></> : null}>
        {!detail && <Skeleton rows={6} />}
        {detail?.missing && <span className="err" style={{ color: "var(--danger)" }}>Invoice not found.</span>}
        {detail && !detail.missing && (
          <>
            <div className="row" style={{ flexWrap: "wrap" }}><Lozenge tone={P.invoiceTone(detail)} style={{ height: 24, padding: "0 8px" }}>{P.invoiceLabel(detail)}</Lozenge><span className="mini">{detail.invoice_title} · {detail.from_date} – {detail.to_date} · issued {detail.invoice_date}</span></div>
            {/* Shown loudly: an invoice that was settled is due again, and the client must not have to notice a badge change to find out. */}
            {detail.unpaid_reason && (
              <div className="callout" style={{ background: "var(--over-bg)", borderColor: "var(--danger)", color: "var(--over)", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
                <b>↺ This payment was reversed — the invoice is due again.</b>
                <span style={{ whiteSpace: "pre-wrap", fontWeight: 500 }}>{detail.unpaid_reason}</span>
                {detail.unpaid_on && <span className="mini">Reverted {detail.unpaid_on}</span>}
              </div>
            )}
            {detail.revised_on && (
              <div className="callout" style={{ background: "var(--lz-prog-bg)", borderColor: "var(--brand)", color: "var(--lz-prog)" }}>
                <span><b>Revised</b> on {detail.revised_on}{detail.revision_reason ? ` — ${detail.revision_reason}` : ""}{detail.revision_count > 1 ? <span className="mini"> (revised {detail.revision_count} times)</span> : null}</span>
              </div>
            )}
            <table className="table"><thead><tr><th>Ref</th><th>Task</th><th className="num">Hours</th><th className="num">Amount</th></tr></thead>
              <tbody>{(detail.lines || []).filter((l) => !l.already_invoiced).map((l) => <tr key={l.id}><td>{l.line_type === "adjustment" ? <Lozenge tone="paused">Adjustment</Lozenge> : <span className="ref">{(l.task_kind || "").toUpperCase()}</span>}</td><td>{l.description}{l.notes && <div className="mini">{l.notes}</div>}</td><td className="num">{l.quoted_hours}h</td><td className="num">{P.money(lineAmount(l, detail), invSymbol(detail))}</td></tr>)}{!(detail.lines || []).length && <tr><td colSpan={4} className="empty">No lines.</td></tr>}</tbody>
              <tfoot><tr><td colSpan={2} style={{ fontWeight: 800, color: "var(--navy)" }}>Total · {detail.grand_total_hours}h{detail.billing_method !== "per_task" ? ` × ${P.money(detail.hourly_rate, invSymbol(detail))}/h` : ""}</td><td /><td className="num" style={{ fontWeight: 900, color: "var(--navy)", fontSize: 15 }}>{P.money(detail.total_amount, invSymbol(detail))}</td></tr></tfoot></table>
            {detail.notes && <p className="note" style={{ margin: 0 }}>{detail.notes}</p>}
            {detail.client_paid_claim && <div className="callout" style={{ background: "var(--lz-review-bg)", borderColor: "var(--tint-violet)", color: "var(--tint-violet-text)" }}>You marked this paid on {detail.client_paid_claim_date}{detail.client_paid_method_label ? ` by ${detail.client_paid_method_label}` : ""} — waiting for the team to confirm.</div>}
            {detail.payment_status === "paid" && <div className="callout" style={{ background: "var(--lz-done-bg)", borderColor: "var(--pri-regular)", color: "var(--lz-done)" }}>Paid. Thank you.</div>}
          </>
        )}
      </Modal>
      <Modal open={!!claim} onClose={() => setClaim(null)} title={claim ? `Mark ${claim.name} as paid` : ""} width={460}
        footer={<><Button kind="ghost" onClick={() => setClaim(null)}>Cancel</Button><Button kind="primary" busy={busy} onClick={doClaim}>Confirm</Button></>}>
        <Field label="How did you pay?"><span className="input"><Select value={method} onChange={(e) => setMethod(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}>{P.PAYMENT_METHODS.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}</Select></span></Field>
        <Field label="Reference / note (optional)"><span className="input"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="UTR, cheque no., date…" style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }} /></span></Field>
      </Modal>
    </>
  );
}
