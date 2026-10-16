"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Confirm, Field, Input, Lozenge, Modal, PageHeader, Skeleton, useDialogs, useFlags, Select } from "@/components/ui";
import * as R from "@/lib/services/reports";

/* One invoice: header, lines (editable while draft), adjustments, notes,
   workflow (finalize → send → paid), revise/delete, the server-built PDF. */
const selStyle = { border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" };
export default function InvoiceDetail({ id }) {
  const router = useRouter();
  const flags = useFlags();
  const dialogs = useDialogs();
  const [inv, setInv] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [dlg, setDlg] = useState(null); /* {kind:'paid'|'revise'|'delete'|'adjust'|'header'} */
  const [f, setF] = useState({});
  const [currencies, setCurrencies] = useState([]);
  const [cur, setCur] = useState(null); /* {id, name} of the invoice's currency_id */
  /* Odoo's "Show amounts": off = a clean, cost-free view (hours only). */
  const [showAmounts, setShowAmounts] = useState(true);
  /* Why a freshly created invoice came out empty (only /create knows; see Invoices). */
  const [emptyReasons, setEmptyReasons] = useState([]);
  useEffect(() => { try { const v = JSON.parse(sessionStorage.getItem(R.invoiceEmptyKey(id)) || "[]"); setEmptyReasons(Array.isArray(v) ? v : []); } catch (e) { setEmptyReasons([]); } }, [id]);
  /* /get carries currency_id + currency_symbol on newer servers; older ones
     need the separate read of currency_id. */
  const load = () => R.fetchInvoice(id).then(async (d) => {
    if (!d) { setErr("Invoice not found."); return; }
    const c = R.invCurrency(d) || (d.currency_symbol ? null : await R.fetchInvoiceCurrency(id));
    setCur(c); setInv(d); setErr("");
  }).catch((e) => setErr(e.message));
  useEffect(() => { R.fetchCurrencies().then(setCurrencies).catch(() => {}); }, []);
  const pdf = async () => { setBusy("pdf"); try { await R.downloadInvoicePdf(id); flags.ok("PDF downloaded."); } catch (e) { flags.err(e.message); } finally { setBusy(""); } };
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (k, fn, ok) => { setBusy(k); try { R.assertOk(await fn(), "Refused."); if (ok) flags.ok(ok); R.invalidateInvoices(); setDlg(null); await load(); } catch (e) { flags.err(e.message); } finally { setBusy(""); } };
  const draft = inv?.state === "draft";
  const curInfo = cur ? currencies.find((c) => c.id === cur.id) : null;
  const sym = inv?.currency_symbol || curInfo?.symbol || "₹";
  /* Locked lines (billed on another invoice) are left out of the total, as on the server. */
  const subtotal = (inv?.lines || []).filter((l) => !l.already_invoiced).reduce((s, l) => s + R.lineAmount(l, inv), 0);
  const paid = inv?.payment_status === "paid";
  /* Mirror the server's guards: reset needs finalized (not sent), revise needs
     finalized; neither while paid or with a client payment claim open. */
  const canReset = inv?.state === "finalized" && !paid && !inv?.client_paid_claim;
  const canRevise = canReset;
  /* Per-task lines still at 0 are billed as free; finalize is the last chance to catch them. */
  const finalize = async () => {
    if (inv.billing_method === "per_task") {
      const kpiLines = (inv.lines || []).filter((l) => l.line_type === "kpi");
      const unpriced = kpiLines.filter((l) => !(Number(l.unit_price) > 0));
      if (unpriced.length) {
        const names = unpriced.slice(0, 8).map((l) => l.description || `Line ${l.id}`).join(", ") + (unpriced.length > 8 ? `, +${unpriced.length - 8} more` : "");
        if (!(await dialogs.confirm({ title: "Some tasks have no price", text: `${unpriced.length} of ${kpiLines.length} tasks on this invoice are still priced at 0, so they will be billed as free. Finalizing locks that in. Unpriced: ${names}.`, confirmLabel: "Finalize anyway" }))) return;
      }
    }
    if (!(await dialogs.confirm({ title: "Finalize this invoice?", text: "It is locked from further edits and becomes visible to the client.", confirmLabel: "Finalize" }))) return;
    run("fin", () => R.finalizeInvoice(id), "Finalized — numbers are locked.");
  };
  const resetDraft = async () => {
    if (!(await dialogs.confirm({ title: "Reset to draft?", text: "The client loses sight of it until you finalize again.", confirmLabel: "Reset to draft" }))) return;
    run("reset", () => R.resetInvoiceDraft(id), "Back to draft.");
  };
  const clearClaim = async () => {
    if (!(await dialogs.confirm({ title: `Clear the payment claim on ${inv.name}?`, text: "Use this when the payment never arrived. The invoice stays unpaid and the client can report paying again.", confirmLabel: "Clear claim" }))) return;
    run("cc", () => R.clearPaidClaim(id), "Claim cleared.");
  };
  /* Revert to due: the reason is required (the server refuses without one) and the client is shown it. */
  const undoPaid = async () => {
    const v = await dialogs.form({ title: `Revert ${inv.name} to due`, text: "Use this when a payment bounced or was recorded in error. Any tasks this invoice archived come back. The client is shown the reason on their invoice.", confirmLabel: "Revert to due", fields: [{ key: "reason", label: "Reason", placeholder: "e.g. cheque returned unpaid by the bank" }] });
    if (!v || !String(v.reason || "").trim()) return;
    run("unpaid", () => R.markInvoicePaid(id, false, String(v.reason).trim(), ""), "Reverted to due.");
  };
  const removeLine = async (l) => {
    if (!(await dialogs.confirm({ title: "Remove this line?", text: "It comes off the invoice and the total updates.", confirmLabel: "Remove", danger: true }))) return;
    run(`r${l.id}`, () => R.removeInvoiceLine(l.id), "Line removed.");
  };
  const doDelete = async () => {
    setBusy("del");
    try { R.assertOk(await R.deleteInvoice(id), "Could not delete the invoice."); flags.ok("Deleted."); R.invalidateInvoices(); setDlg(null); router.push("/reports/invoices"); }
    catch (e) { flags.err(e.message); } finally { setBusy(""); }
  };

  if (err) return <div className="page"><div className="callout" style={{ background: "var(--over-bg)", borderColor: "var(--danger)", color: "var(--over)" }}>{err} <Link href="/reports/invoices">Back to invoices</Link></div></div>;
  if (!inv) return <div className="page"><div className="cardbox"><Skeleton rows={8} /></div></div>;

  return (
    <>
      <PageHeader crumbs={[{ label: "Reports" }, { label: "Client invoices", href: "/reports/invoices" }, { label: inv.name }]} title={`${inv.name} · ${inv.client_name}`}>
        <Lozenge tone={R.invTone(inv)} style={{ height: 24, padding: "0 8px" }}>{R.invLabel(inv)}</Lozenge>
        <label className="chk" style={{ fontSize: 12.5 }} title="Off = hide every price and amount on this screen"><span className={`toggle ${showAmounts ? "on" : ""}`} role="switch" aria-checked={showAmounts} tabIndex={0} onClick={() => setShowAmounts((v) => !v)} onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); setShowAmounts((v) => !v); } }} style={{ cursor: "pointer" }} />Show amounts</label>
        <Button icon="download" busy={busy === "pdf"} onClick={pdf}>Download PDF</Button>
        {draft && <Button kind="primary" busy={busy === "fin"} onClick={finalize}>Finalize</Button>}
        {inv.state === "finalized" && <Button kind="primary" busy={busy === "send"} onClick={() => run("send", () => R.sendInvoice(id), "Sent to the client.")}>Send to client</Button>}
        {inv.payment_status !== "paid" && !draft && <Button kind="ok" onClick={() => { setF({ method: "bank_transfer", note: "" }); setDlg("paid"); }}>Mark paid</Button>}
      </PageHeader>
      <div className="g21" style={{ flex: 1, minHeight: 0 }} id="invoice-print">
        <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          {inv.unpaid_reason && (
            <div className="callout" style={{ background: "var(--over-bg)", borderColor: "var(--danger)", color: "var(--over)", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
              <b>↺ Payment reverted to due.</b>
              <span style={{ whiteSpace: "pre-wrap", fontWeight: 500 }}>{inv.unpaid_reason}</span>
              {inv.unpaid_on && <span className="mini">Reverted {inv.unpaid_on}</span>}
            </div>
          )}
          {inv.revised_on && (
            <div className="callout" style={{ background: "var(--lz-prog-bg)", borderColor: "var(--brand)", color: "var(--lz-prog)" }}>
              <span><b>Revised</b> on {inv.revised_on}{inv.revision_reason ? ` — ${inv.revision_reason}` : ""}{inv.revision_count > 1 ? <span className="mini"> (revised {inv.revision_count} times)</span> : null}</span>
            </div>
          )}
          <div className="cardbox"><h2>Header <span className="right">{draft && <Button size="sm" onClick={() => { setF({ invoice_title: inv.invoice_title || "", hourly_rate: inv.hourly_rate || 0, billing_method: inv.billing_method || "hourly", currency_id: cur?.id ? String(cur.id) : "", price_req: inv.price_req || 0, price_upt: inv.price_upt || 0, price_bug: inv.price_bug || 0 }); setDlg("header"); }}>Edit</Button>}</span></h2>
            <div className="grid3" style={{ gap: 10 }}>
              {[["Client", `${inv.client_name}${inv.parent_name ? ` · ${inv.parent_name}` : ""}`], ["Title", inv.invoice_title || "—"], ["Period", `${inv.from_date} – ${inv.to_date}`], ["Invoice date", inv.invoice_date], ["Currency", cur ? `${cur.name || curInfo?.name || ""}${(curInfo?.symbol || inv.currency_symbol) ? ` (${curInfo?.symbol || inv.currency_symbol})` : ""}` : inv.currency_symbol ? `Client default (${inv.currency_symbol})` : "Client default"], ["Billing", !showAmounts ? (inv.billing_method === "hourly" ? "Hourly" : "Per task") : inv.billing_method === "hourly" ? `Hourly · ${R.money(inv.hourly_rate, sym)}/h` : `Per task · REQ ${inv.price_req} / UPT ${inv.price_upt} / BUG ${inv.price_bug}`], ["Hours", `${inv.grand_total_hours}h (quoted ${inv.total_quoted_hours}h · actual ${inv.total_actual_hours}h)`]].map(([k, v]) => <div key={k} className="kv" style={{ border: 0, padding: "4px 0", flexDirection: "column", alignItems: "flex-start", gap: 2 }}><span className="mini">{k}</span><span className="val">{v}</span></div>)}
            </div>
          </div>
          <div className="cardbox table-scroll" style={{ padding: 0 }}>
            <h2 style={{ padding: "14px 16px 0" }}>Lines <small>{inv.lines?.length || 0}</small><span className="right">{draft && <Button size="sm" onClick={() => { setF({ description: "", quoted_hours: 0, notes: "" }); setDlg("adjust"); }}>+ Adjustment</Button>}</span></h2>
            <table className="table" style={{ marginTop: 8 }}>
              <thead><tr><th>Ref / type</th><th>Description</th><th>Contributors</th><th className="num">Quoted h</th><th className="num">Actual h</th>{showAmounts && <th className="num">Rate</th>}{showAmounts && <th className="num">Amount</th>}{draft && <th />}</tr></thead>
              <tbody>{(inv.lines || []).map((l) => <LineRow key={l.id} l={l} inv={inv} draft={draft} sym={sym} showAmounts={showAmounts} onSave={(p) => run(`l${l.id}`, () => R.saveInvoiceLine({ invoice_id: +id, line_id: l.id, ...p }), "Line saved.")} onRemove={() => removeLine(l)} />)}{!(inv.lines || []).length && <tr><td colSpan={8} className="empty">No lines yet.</td></tr>}</tbody>
              <tfoot><tr><td colSpan={showAmounts ? 6 : 3} style={{ fontWeight: 900, color: "var(--navy)", fontSize: 15 }}>Total</td>{showAmounts ? <td className="num" style={{ fontWeight: 900, color: "var(--navy)", fontSize: 15 }}>{R.money(inv.total_amount || subtotal, sym)}</td> : <td colSpan={2} className="num" style={{ fontWeight: 900, color: "var(--navy)", fontSize: 15 }}>{inv.grand_total_hours}h</td>}{draft && <td />}</tr></tfoot>
            </table>
            {!(inv.lines || []).length && emptyReasons.length > 0 && (
              <div className="callout" style={{ margin: 12, background: "var(--lz-paused-bg)", borderColor: "var(--pri-important)", color: "var(--lz-paused)", flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
                <b>Nothing to bill for this period</b>
                <ul style={{ margin: 0, paddingLeft: 18, fontWeight: 500 }}>{emptyReasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                <span className="mini">Work becomes billable only once the client has signed it off in their portal. You can delete this draft and create it again after they do.</span>
              </div>
            )}
          </div>
          <div className="cardbox"><h2>Notes to client</h2><NotesBox value={inv.notes || ""} onSave={(n) => run("notes", () => R.saveInvoiceNotes(id, n), "Notes saved.")} /></div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          <div className="cardbox"><h2>Workflow</h2>
            <div className="steps" style={{ flexDirection: "column", alignItems: "flex-start", gap: 10 }}>
              <span className={draft ? "on" : ""}><b>1</b>Draft — edit lines</span><span className={inv.state === "finalized" ? "on" : ""}><b>2</b>Finalize — numbers locked</span><span className={inv.state === "sent" ? "on" : ""}><b>3</b>Send to client</span><span className={inv.payment_status === "paid" ? "on" : ""}><b>4</b>Paid</span>
            </div>
            {inv.client_paid_claim && <div className="callout" style={{ background: "var(--lz-review-bg)", borderColor: "var(--tint-violet)", color: "var(--tint-violet-text)" }}><span style={{ flex: 1 }}>Client says paid on {inv.client_paid_claim_date}{inv.client_paid_method_label ? ` by ${inv.client_paid_method_label}` : ""}{inv.client_paid_notes ? ` — "${inv.client_paid_notes}"` : ""}.</span><Button size="sm" kind="ok" onClick={() => { setF({ method: inv.client_paid_method || "bank_transfer", note: inv.client_paid_notes || "" }); setDlg("paid"); }}>Confirm</Button><Button size="sm" kind="ghost" busy={busy === "cc"} onClick={clearClaim} title="The payment never arrived — clear the claim">Not received</Button></div>}
            {inv.payment_status === "paid" && <div className="callout" style={{ background: "var(--lz-done-bg)", borderColor: "var(--pri-regular)", color: "var(--lz-done)" }}><span style={{ flex: 1 }}>Paid on {inv.payment_date}{inv.payment_method_label ? ` by ${inv.payment_method_label}` : ""}{inv.paid_by_name ? ` · ${inv.paid_by_name}` : ""}. Its tasks are archived to Paid work.</span><Button size="sm" kind="ghost" busy={busy === "unpaid"} onClick={undoPaid} title="Revert to due (payment bounced / wrong entry)">Undo</Button></div>}
            <div className="row" style={{ flexWrap: "wrap" }}>
              {canReset && <Button kind="ghost" busy={busy === "reset"} onClick={resetDraft}>Reset to draft</Button>}
              {canRevise && <Button kind="ghost" onClick={() => { setF({ reason: "" }); setDlg("revise"); }}>Revise</Button>}
              {draft && !paid && <Button kind="danger" onClick={() => setDlg("delete")}>Delete draft</Button>}
            </div>
            {inv.state === "finalized" && !paid && inv.client_paid_claim && <p className="mini" style={{ margin: 0 }}>Revise and Reset are locked while the client&apos;s payment claim is open — confirm it, or clear it if the money never arrived.</p>}
          </div>
        </div>
      </div>

      <Modal open={dlg === "header"} onClose={() => setDlg(null)} title="Edit header" width={480} footer={<><Button kind="ghost" onClick={() => setDlg(null)}>Cancel</Button><Button kind="primary" busy={busy === "hdr"} onClick={() => run("hdr", () => R.saveInvoiceHeader({ invoice_id: +id, invoice_title: f.invoice_title, billing_method: f.billing_method, currency_id: f.currency_id ? +f.currency_id : false, ...(f.billing_method === "per_task" ? { price_req: +f.price_req || 0, price_upt: +f.price_upt || 0, price_bug: +f.price_bug || 0 } : { hourly_rate: +f.hourly_rate || 0 }) }), "Header saved.")}>Save</Button></>}>
        <Field label="Title"><Input value={f.invoice_title || ""} onChange={(e) => setF({ ...f, invoice_title: e.target.value })} /></Field>
        <Field label="Currency"><span className="input"><Select value={f.currency_id || ""} onChange={(e) => setF({ ...f, currency_id: e.target.value })} style={selStyle}><option value="">Client default</option>{currencies.map((c) => <option key={c.id} value={String(c.id)}>{c.name} ({c.symbol})</option>)}</Select></span></Field>
        <div className="grid2"><Field label="Billing method"><span className="input"><Select value={f.billing_method} onChange={(e) => setF({ ...f, billing_method: e.target.value })} style={selStyle}><option value="hourly">Hourly</option><option value="per_task">Per task</option></Select></span></Field>{f.billing_method === "per_task" ? <span /> : <Field label="Hourly rate"><Input type="number" min="0" value={f.hourly_rate} onChange={(e) => setF({ ...f, hourly_rate: e.target.value })} /></Field>}</div>
        {f.billing_method === "per_task" && <div className="grid3" style={{ gap: 8 }}><Field label="REQ price"><Input type="number" min="0" value={f.price_req} onChange={(e) => setF({ ...f, price_req: e.target.value })} /></Field><Field label="UPT price"><Input type="number" min="0" value={f.price_upt} onChange={(e) => setF({ ...f, price_upt: e.target.value })} /></Field><Field label="BUG price"><Input type="number" min="0" value={f.price_bug} onChange={(e) => setF({ ...f, price_bug: e.target.value })} /></Field></div>}
        {f.billing_method === "per_task" && <p className="mini" style={{ margin: 0 }}>Changing the method or a type price re-prices every task line by its type.</p>}
      </Modal>
      <Modal open={dlg === "adjust"} onClose={() => setDlg(null)} title="Add adjustment" width={460} footer={<><Button kind="ghost" onClick={() => setDlg(null)}>Cancel</Button><Button kind="primary" busy={busy === "adj"} disabled={!f.description} onClick={() => run("adj", () => R.addAdjustment({ invoice_id: +id, description: f.description, quoted_hours: +f.quoted_hours || 0, notes: f.notes || "" }), "Adjustment added.")}>Add</Button></>}>
        <Field label="Description"><Input value={f.description || ""} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. Goodwill discount" autoFocus /></Field>
        <Field label="Hours (negative to deduct)"><Input type="number" step="0.25" value={f.quoted_hours} onChange={(e) => setF({ ...f, quoted_hours: e.target.value })} /></Field>
        <Field label="Note (optional)"><Input value={f.notes || ""} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </Modal>
      <Modal open={dlg === "paid"} onClose={() => setDlg(null)} title={`Mark ${inv.name} paid`} width={460} footer={<><Button kind="ghost" onClick={() => setDlg(null)}>Cancel</Button><Button kind="ok" busy={busy === "paid"} onClick={() => run("paid", () => R.markInvoicePaid(id, true, f.note, f.method), "Marked paid — tasks moved to Paid work.")}>Mark paid</Button></>}>
        <Field label="Method"><span className="input"><Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}>{R.PAYMENT_METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></span></Field>
        <Field label="Note (optional)"><Input value={f.note || ""} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="UTR / reference" /></Field>
      </Modal>
      <Modal open={dlg === "revise"} onClose={() => setDlg(null)} title="Revise invoice" width={460} footer={<><Button kind="ghost" onClick={() => setDlg(null)}>Cancel</Button><Button kind="primary" busy={busy === "rev"} disabled={!f.reason} onClick={() => run("rev", () => R.reviseInvoice(id, f.reason), "Revision opened as a draft.")}>Revise</Button></>}>
        <p className="note" style={{ margin: 0 }}>Reopens the invoice as a draft with a revision number; the client sees the reason.</p>
        <Field label="Reason"><Input value={f.reason || ""} onChange={(e) => setF({ ...f, reason: e.target.value })} autoFocus /></Field>
      </Modal>
      <Confirm open={dlg === "delete"} onClose={() => setDlg(null)} title={`Delete ${inv.name}?`} text="Only drafts can be deleted. Its tasks become available for a new invoice." confirmLabel="Delete" danger busy={busy === "del"} onConfirm={doDelete} />
      <style>{`@media print { .k-app .top, .k-app .side, .k-app .head > span, .k-app .crumbs, .flags, .steps, .k-app .cardbox h2 .right { display: none !important; } .k-app .main { padding: 0 !important; } .k-app .g21 { grid-template-columns: 1fr !important; } .k-app .cardbox { box-shadow: none !important; border-color: #ccc !important; break-inside: avoid; } }`}</style>
    </>
  );
}

function LineRow({ l, inv, draft, sym, showAmounts = true, onSave, onRemove }) {
  const [edit, setEdit] = useState(false);
  /* Per task: the line's own unit_price is its amount (editable here).
     Hourly: quoted_hours × the invoice's hourly_rate (edited in the header). */
  const perTask = inv.billing_method === "per_task";
  /* Billed on another invoice: read-only (the server refuses edits) and left out of the total. */
  const locked = !!l.already_invoiced;
  const [q, setQ] = useState(l.quoted_hours); const [p, setP] = useState(l.unit_price || 0); const [d, setD] = useState(l.description);
  const amount = R.lineAmount(l, inv);
  const editAmount = perTask ? (+p || 0) : (+q || 0) * (Number(inv.hourly_rate) || 0);
  const lockBadge = locked ? <Lozenge tone="danger" style={{ marginLeft: 6 }}>🔒 Billed on {l.invoiced_on || "another invoice"}</Lozenge> : null;
  const signoff = l.client_signoff_notes ? <div className="mini" style={{ whiteSpace: "pre-wrap" }}>“{l.client_signoff_notes}”{l.client_signed_by ? ` — ${l.client_signed_by}` : ""}</div> : null;
  if (edit && !locked) return (
    <tr className="sel">
      <td>{l.line_type === "adjustment" ? <Lozenge tone="paused">Adjustment</Lozenge> : <span className="ref">{(l.task_kind || "").toUpperCase()}</span>}</td>
      <td><span className="input" style={{ height: 30 }}><input value={d} onChange={(e) => setD(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }} /></span></td>
      <td className="mini">{(l.contributors || []).map((c) => c.name).join(", ")}</td>
      <td className="num"><span className="input" style={{ height: 30, width: 80 }}><input type="number" step="0.25" value={q} onChange={(e) => setQ(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit", textAlign: "right" }} /></span></td>
      <td className="num">{l.actual_hours}</td>
      {showAmounts && <td className="num">{perTask ? <span className="input" style={{ height: 30, width: 90 }}><input type="number" step="1" value={p} onChange={(e) => setP(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit", textAlign: "right" }} /></span> : `${R.money(inv.hourly_rate, sym)}/h`}</td>}
      {showAmounts && <td className="num">{R.money(editAmount, sym)}</td>}
      <td><span style={{ display: "inline-flex", gap: 4 }}><Button size="sm" kind="primary" onClick={() => { onSave({ description: d, quoted_hours: +q || 0, ...(perTask && showAmounts ? { unit_price: +p || 0 } : {}), notes: l.notes || "" }); setEdit(false); }}>Save</Button><Button size="sm" kind="ghost" onClick={() => setEdit(false)}>Cancel</Button></span></td>
    </tr>
  );
  return (
    <tr style={locked ? { background: "var(--over-bg)" } : l.line_type === "adjustment" ? { background: "var(--lz-paused-bg)" } : undefined}>
      <td>{l.line_type === "adjustment" ? <Lozenge tone="paused">Adjustment</Lozenge> : <span className="ref">{l.external_ref || (l.task_kind || "").toUpperCase()}</span>}</td>
      <td><b>{l.description}</b>{lockBadge}{l.notes && <div className="mini">{l.notes}</div>}{signoff}</td>
      <td className="mini">{(l.contributors || []).map((c) => `${c.name}${c.hours ? ` ${c.hours}h` : ""}`).join(", ") || "—"}</td>
      <td className="num">{l.quoted_hours}</td><td className="num">{l.actual_hours ?? "—"}</td>
      {showAmounts && <td className="num">{R.money(R.lineRate(l, inv), sym)}{perTask ? "" : "/h"}</td>}
      {showAmounts && <td className="num">{locked ? <span className="mini">not billed</span> : <b>{R.money(amount, sym)}</b>}</td>}
      {draft && <td>{locked ? <span className="mini">locked</span> : <span style={{ display: "inline-flex", gap: 4 }}><Button size="sm" onClick={() => setEdit(true)}>Edit</Button><Button size="sm" kind="ghost" onClick={onRemove}>Remove</Button></span>}</td>}
    </tr>
  );
}
function NotesBox({ value, onSave }) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  return (<><span className="input ta" style={{ height: 80 }}><textarea value={v} onChange={(e) => setV(e.target.value)} style={{ border: 0, background: "none", outline: 0, resize: "none", width: "100%", height: "100%", font: "inherit", color: "inherit" }} /></span>{v !== value && <Button size="sm" kind="primary" style={{ alignSelf: "flex-start" }} onClick={() => onSave(v)}>Save notes</Button>}</>);
}
