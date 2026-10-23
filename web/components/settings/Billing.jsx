"use client";
import { useEffect, useState } from "react";
import { Button, Field, Lozenge, PageHeader, Select, useDialogs, useFlags } from "@/components/ui";
import * as S from "@/lib/services/settings";
import SettingsNav from "./SettingsNav";

/* Settings › Billing. */
export default function Billing() {
  const flags = useFlags();
  return (
    <>
      <PageHeader crumbs={[{ label: "Settings" }, { label: "Billing" }]} title="Billing" />
      <SettingsNav />
      <div className="page"><BillingCard flags={flags} /></div>
    </>
  );
}

/* 🧾 The price list a bill is made from when a task is Full Complete
   (models/kpi_billing.py), and the WhatsApp numbers each bill and payment go
   to. Admins only: the routes refuse anyone else. */
const BOX = { border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", width: "100%" };
const FAR = "9999-12-31";
/* The price `edit` would clash with: same client (or Default), same work type,
   overlapping days (no dates = always). The server refuses it too. */
const duplicateOf = (rates, e) => {
  if (!e) return null;
  const from = e.date_from || "0000-01-01", to = e.date_to || FAR;
  return (rates || []).find((r) => r.id !== e.id && String(r.client_id || "") === String(e.client_id || "") && r.work_type === e.work_type
    && (r.date_from || "0000-01-01") <= to && from <= (r.date_to || FAR)) || null;
};

function BillingCard({ flags }) {
  const dlg = useDialogs();
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  /* WhatsApp groups for the invoice group pickers (same list as Configuration's group card). */
  const [groups, setGroups] = useState([]);
  const loadGroups = () => S.fetchWaGroups().then((g) => { if (g?.status !== false) setGroups((g?.groups || []).filter((x) => String(x.jid || "").endsWith("@g.us"))); }).catch(() => {});
  const load = () => S.billing.config().then((r) => {
    if (!r?.status) { setData(false); return; }
    setData(r);
  }).catch(() => setData(false));
  useEffect(() => { load(); loadGroups(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (data === null) return <div className="cardbox"><span className="mini">Loading…</span></div>;
  if (data === false) return <div className="callout">Only an admin can change billing.</div>;
  /* A new price starts on the first work type the Default has no price for yet. */
  const usedTypes = new Set((data.rates || []).filter((r) => !r.client_id && r.always).map((r) => r.work_type));
  const blank = () => ({
    id: false, client_id: "", work_type: (data.work_types || []).find((w) => !usedTypes.has(w.key))?.key || data.work_types?.[0]?.key || "requirement", method: "per_task", amount: "",
    /* the currency already in use (the newest price's), else the company's */
    currency_id: String((data.rates || []).reduce((a, r) => (!a || r.id > a.id ? r : a), null)?.currency_id || data.company_currency_id || data.currencies?.[0]?.id || ""), date_from: "", date_to: "", note: "", showDates: false,
  });
  const fromRate = (r) => ({ ...r, client_id: r.client_id ? String(r.client_id) : "", currency_id: String(r.currency_id), date_from: r.date_from || "", date_to: r.date_to || "", note: r.note || "", showDates: !r.always });
  const set = (k) => (e) => setEdit((x) => ({ ...x, [k]: e.target.value }));
  const dup = duplicateOf(data.rates, edit);
  /* Sections: the Default, then every client, each with every work type. A type
     with no price of its own uses the Default's; with neither, no bill (red). */
  const today = new Date().toISOString().slice(0, 10);
  const live = (r) => r.always || ((r.date_from || "0000-01-01") <= today && today <= (r.date_to || FAR));
  const ofClient = (id) => (data.rates || []).filter((r) => String(r.client_id || "") === String(id || ""));
  const defaults = ofClient("");
  const build = (key, name, isDefault, client) => {
    const mine = ofClient(key);
    const types = (data.work_types || []).map((w) => ({
      key: w.key, label: w.label, rates: mine.filter((r) => r.work_type === w.key),
      fallback: isDefault ? null : (defaults.find((r) => r.work_type === w.key && live(r)) || null),
    }));
    /* The Default is optional: only a client's own gap is "missing". */
    return { key, name, isDefault, client, types, own: mine.length, missing: isDefault ? 0 : types.filter((t) => !t.rates.length && !t.fallback).length };
  };
  const sections = [build("", "Default (every client)", true), ...(data.clients || []).map((c) => build(String(c.id), c.name, false, c))];
  const missingTotal = sections.filter((x) => !x.isDefault).reduce((n, x) => n + x.missing, 0);
  /* "+ Add" in a section: a new price for that client and work type, then the form. */
  const addFor = (clientKey, workType) => {
    setErr("");
    setEdit({ ...blank(), client_id: clientKey || "", work_type: workType });
    setTimeout(() => document.getElementById("billing-form")?.scrollIntoView({ block: "center", behavior: "smooth" }), 50);
  };
  const saveRate = async () => {
    if (dup) return;
    if (edit.amount === "" || Number.isNaN(parseFloat(edit.amount))) { setErr("Enter the amount."); return; }
    setBusy(true); setErr("");
    try {
      const r = await S.billing.saveRate(edit);
      if (!r?.status) { setErr(r?.message || "Could not save the price."); return; }
      setEdit(null); flags.ok("Price saved."); await load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const del = async (r) => {
    if (!(await dlg.confirm({ title: "Delete this price?", text: `${r.client_name || "Default"} · ${r.work_type_label}. A price already used on a bill is kept for that bill and only hidden here.`, confirmLabel: "Delete" }))) return;
    const res = await S.billing.deleteRate(r.id).catch((e) => ({ status: false, message: e.message }));
    if (!res?.status) { flags.err(res?.message || "Could not delete."); return; }
    if (edit?.id === r.id) setEdit(null);
    flags.ok(res.archived ? "Hidden — it is on a bill already." : "Deleted."); load();
  };
  const clientSet = async (c, vals) => {
    const r = await S.billing.clientInvoice(c.id, vals).catch((e) => ({ status: false, message: e.message }));
    if (!r?.status) { flags.err(r?.message || "Could not save."); return; }
    setData((d) => ({ ...d, clients: d.clients.map((x) => (x.id === c.id ? { ...x, invoice_group_jid: r.invoice_group_jid, invoice_group_name: r.invoice_group_name, send_invoice: r.send_invoice,
      bill_address: r.bill_address, bill_phone: r.bill_phone, bill_email: r.bill_email, bill_tax_id: r.bill_tax_id, bill_logo: r.bill_logo } : x)) }));
    return true;
  };
  const curLabel = (c) => `${c.name}${c.symbol ? ` (${c.symbol})` : ""}`;
  const bad = dup ? { borderColor: "var(--danger)" } : undefined;
  return (
    <>
      <div className="cardbox">
        <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>🧾 Prices
          {!edit && <Button kind="primary" icon="plus" style={{ marginLeft: "auto" }} onClick={() => { setErr(""); setEdit(blank()); }}>Add price</Button>}
        </h2>
        <p className="mini" style={{ margin: "0 0 10px" }}>When a task is <b>Full Complete</b>, its bill is made from this list: the client's own price if it has one, else the Default. <b>Per task</b> bills the amount once; <b>Hourly</b> bills the client's quoted hours (or the time logged) × the amount. Each client has one price per work type; one it doesn't have uses the Default.</p>
        {/* One section per client (the Default first), every work type in it:
            its price, or red when no bill can be made for it. */}
        {missingTotal > 0 && <div className="callout" role="alert" style={{ borderColor: "var(--danger)", color: "var(--danger)", fontWeight: 600, marginBottom: 10 }}>⚠ {missingTotal} price(s) missing: tasks of those types are fully completed but get no bill. Add them below.</div>}
        {sections.map((sec) => (
          <div key={sec.key || "default"} style={{ border: "1px solid var(--border)", borderRadius: 10, marginBottom: 12, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "8px 12px", background: "var(--surface-2, var(--lz-todo-bg))", borderBottom: "1px solid var(--border)" }}>
              <b>{sec.name}</b>
              {sec.isDefault && <span className="mini">used for any client without its own price</span>}
              {sec.missing > 0 ? <Lozenge tone="danger">{sec.missing} missing</Lozenge> : !sec.isDefault ? <Lozenge tone="done">✓ complete</Lozenge> : null}
              {/* Invoices on: each fully complete task makes a bill, posted in this client's invoice group. Off: no bill (Bill now by hand). */}
              {!sec.isDefault && (
                <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className="mini">Invoice group</span>
                  <span className="input" style={{ height: 30, minWidth: 200 }}>
                    <Select value={sec.client.invoice_group_jid || ""} aria-label={`Invoice group for ${sec.name}`} style={BOX}
                      onChange={(e) => { const g = groups.find((x) => x.jid === e.target.value); clientSet(sec.client, { jid: e.target.value, name: g?.name || "" }); }}>
                      <option value="">Choose a WhatsApp group…</option>
                      {sec.client.invoice_group_jid && !groups.some((g) => g.jid === sec.client.invoice_group_jid) && <option value={sec.client.invoice_group_jid}>{sec.client.invoice_group_name || sec.client.invoice_group_jid}</option>}
                      {groups.map((g) => <option key={g.jid} value={g.jid}>{g.name || g.jid}</option>)}
                    </Select>
                  </span>
                  <Button kind="ghost" icon="refresh" aria-label="Refresh the group list" onClick={loadGroups} />
                  <label title={sec.client.send_invoice ? "On: each fully complete task makes a bill and posts it in the invoice group" : "Off: no bill is made (Bill now on the task makes one by hand)"}
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontWeight: 600, fontSize: 13, color: sec.client.send_invoice ? "var(--lz-done)" : "var(--subtle, inherit)" }}>
                    <span className={`toggle ${sec.client.send_invoice ? "on" : ""}`} role="switch" aria-checked={!!sec.client.send_invoice} tabIndex={0}
                      onClick={() => clientSet(sec.client, { send: !sec.client.send_invoice })}
                      onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); clientSet(sec.client, { send: !sec.client.send_invoice }); } }} />
                    Invoices: {sec.client.send_invoice ? "on" : "off"}
                  </label>
                </span>
              )}
            </div>
            {!sec.isDefault && sec.client.send_invoice && !sec.client.invoice_group_jid && (
              <div role="alert" style={{ padding: "6px 12px", background: "var(--over-bg)", color: "var(--danger)", fontWeight: 600, fontSize: 13 }}>⚠ Invoices are on, but no invoice group is picked: bills are made but not sent.</div>
            )}
            {!sec.isDefault && <BillDetails client={sec.client} save={(details) => clientSet(sec.client, { details })} />}
            <div style={{ overflowX: "auto" }}>
              <table className="table" style={{ width: "100%", minWidth: 620, margin: 0 }}>
                <tbody>
                  {sec.types.map((ty) => (ty.rates.length ? ty.rates.map((r) => (
                    <tr key={r.id} style={edit?.id === r.id ? { background: "var(--lz-paused-bg)" } : undefined}>
                      <td style={{ width: "22%", fontWeight: 600 }}>{ty.label}</td>
                      <td style={{ width: "16%" }}>{r.method === "hourly" ? "Hourly" : "Per task"}</td>
                      <td style={{ width: "16%", textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{r.currency_symbol || r.currency} {Number(r.amount).toFixed(2)}{r.method === "hourly" ? " /h" : ""}</td>
                      <td className="mini" style={{ width: "18%", whiteSpace: "nowrap" }}>{r.always ? "Always" : r.range_label}</td>
                      <td className="mini">{r.note}</td>
                      <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                        <Button kind="ghost" icon="pen" aria-label={`Edit the ${ty.label} price`} onClick={() => { setErr(""); setEdit(fromRate(r)); }} />
                        <Button kind="ghost" icon="trash" aria-label={`Delete the ${ty.label} price`} onClick={() => del(r)} />
                      </td>
                    </tr>
                  )) : ty.fallback ? (
                    <tr key={ty.key} style={{ background: "var(--lz-paused-bg)" }}>
                      <td style={{ fontWeight: 600 }}>{ty.label}</td>
                      <td colSpan={4} className="mini">Uses the Default: {ty.fallback.price_label}</td>
                      <td style={{ textAlign: "right" }}><Button kind="ghost" onClick={() => addFor(sec.key, ty.key)}>+ Own price</Button></td>
                    </tr>
                  ) : sec.isDefault ? (
                    <tr key={ty.key}>
                      <td style={{ fontWeight: 600, color: "var(--subtle, inherit)" }}>{ty.label}</td>
                      <td colSpan={4} className="mini">Not set (optional): a client without its own price gets no bill</td>
                      <td style={{ textAlign: "right" }}><Button kind="ghost" onClick={() => addFor(sec.key, ty.key)}>+ Add</Button></td>
                    </tr>
                  ) : (
                    <tr key={ty.key} style={{ background: "var(--over-bg)" }}>
                      <td style={{ fontWeight: 600, color: "var(--danger)" }}>{ty.label}</td>
                      <td colSpan={4} style={{ color: "var(--danger)", fontWeight: 600, fontSize: 13 }}>⚠ No price: no bill can be made</td>
                      <td style={{ textAlign: "right" }}><Button kind="danger" onClick={() => addFor(sec.key, ty.key)}>+ Add</Button></td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        {/* Add / edit: a form under the table, a label over each field. */}
        {edit && (
          <div id="billing-form" style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 14, marginTop: 12, background: "var(--lz-paused-bg)" }}>
            <b>{edit.id ? `Editing the ${(data.work_types || []).find((w) => w.key === edit.work_type)?.label || edit.work_type} price of ${edit.client_id ? ((data.clients || []).find((c) => String(c.id) === String(edit.client_id))?.name || "this client") : "the Default"}` : "New price"}</b>
            {edit.id && <div className="mini" style={{ marginTop: 4 }}>Client and work type stay as they are. For another work type, Cancel and use <b>Add price</b>.</div>}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 10 }}>
              <Field label="Client"><span className="input" style={bad}><Select value={edit.client_id} onChange={set("client_id")} disabled={!!edit.id} style={BOX}><option value="">Default (every client)</option>{(data.clients || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></span></Field>
              <Field label="Work type"><span className="input" style={bad}><Select value={edit.work_type} onChange={set("work_type")} disabled={!!edit.id} style={BOX}>{(data.work_types || []).map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}</Select></span></Field>
              <Field label="Method"><span className="input"><Select value={edit.method} onChange={set("method")} style={BOX}><option value="per_task">Per task (fixed amount)</option><option value="hourly">Hourly (amount × hours)</option></Select></span></Field>
            </div>
            {dup && (
              <div role="alert" style={{ color: "var(--danger)", fontWeight: 600, fontSize: 13, marginTop: 8 }}>
                ⚠ {dup.client_name || "The Default"} already has a {dup.work_type_label} price ({dup.price_label}{dup.always ? "" : `, ${dup.range_label}`}).{" "}
                <button type="button" onClick={() => setEdit(fromRate(dup))} style={{ border: 0, background: "none", color: "var(--danger)", textDecoration: "underline", cursor: "pointer", font: "inherit", padding: 0 }}>Edit that one instead</button>
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 12 }}>
              <Field label="Currency"><span className="input"><Select value={edit.currency_id} onChange={set("currency_id")} style={BOX}>
                <optgroup label="In use">{(data.currencies || []).filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{curLabel(c)}</option>)}</optgroup>
                <optgroup label="All currencies">{(data.currencies || []).filter((c) => !c.active).map((c) => <option key={c.id} value={c.id}>{curLabel(c)}</option>)}</optgroup>
              </Select></span></Field>
              <Field label={`Amount ${edit.method === "hourly" ? "(per hour)" : "(per task)"}`}><span className="input"><input type="number" min="0" step="0.01" placeholder="0.00" value={edit.amount} onChange={set("amount")} style={{ ...BOX, textAlign: "right" }} /></span></Field>
              <Field label="Note (optional)"><span className="input"><input value={edit.note} maxLength={200} onChange={set("note")} style={BOX} /></span></Field>
            </div>
            {!edit.showDates
              ? <button type="button" className="mini" onClick={() => setEdit((x) => ({ ...x, showDates: true }))} style={{ border: 0, background: "none", color: "var(--brand)", cursor: "pointer", padding: 0, marginTop: 10 }}>📅 Set dates (optional): only to plan a price change ahead</button>
              : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 12 }}>
                  <Field label="From (empty = always)"><span className="input"><input type="date" value={edit.date_from} onChange={set("date_from")} style={BOX} /></span></Field>
                  <Field label="To (empty = no end)"><span className="input"><input type="date" value={edit.date_to} onChange={set("date_to")} style={BOX} /></span></Field>
                </div>
              )}
            {err && <div role="alert" style={{ color: "var(--danger)", fontWeight: 600, fontSize: 13, marginTop: 10 }}>⚠ {err}</div>}
            <div className="row" style={{ marginTop: 12, gap: 8 }}>
              <Button kind="ok" busy={busy} disabled={!!dup} onClick={saveRate}>Save</Button>
              <Button kind="ghost" onClick={() => { setEdit(null); setErr(""); }}>Cancel</Button>
            </div>
          </div>
        )}
      </div>

    </>
  );
}

/* The client's logo and details, printed under Bill To on its invoices
   (kra.master logo + kpi_bill_*; /kpi_billing/client_invoice_set details). */
function BillDetails({ client, save }) {
  const [f, setF] = useState(() => ({ address: client.bill_address || "", phone: client.bill_phone || "", email: client.bill_email || "", tax_id: client.bill_tax_id || "" }));
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const pick = (e) => {
    const file = e.target.files && e.target.files[0]; e.target.value = "";
    if (!file) return;
    const rd = new FileReader(); rd.onload = () => save({ logo: rd.result }); rd.readAsDataURL(file);
  };
  const IN = { border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px", font: "inherit", flex: "1 1 160px", minWidth: 0 };
  return (
    <details style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
      <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 13 }}>Invoice details (logo, address, tax no){client.bill_logo || client.bill_address ? " ✓" : ""}</summary>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 8, alignItems: "flex-start" }}>
        <div style={{ width: 140, textAlign: "center" }}>
          <div style={{ height: 70, border: "1px solid var(--border)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: "#fff" }}>
            {client.bill_logo ? <img src={client.bill_logo} alt="Client logo" style={{ maxHeight: 64, maxWidth: 130 }} /> : <span className="mini">No logo</span>}
          </div>
          <label className="mini" style={{ cursor: "pointer", color: "var(--brand)", display: "inline-block", marginTop: 4 }}>Upload logo<input type="file" accept="image/*" hidden onChange={pick} /></label>
          {client.bill_logo && <button type="button" className="mini" style={{ marginLeft: 8, color: "var(--danger)", background: "none", border: 0, cursor: "pointer" }} onClick={() => save({ logo: "" })}>Remove</button>}
        </div>
        <div style={{ flex: "1 1 280px", display: "flex", flexDirection: "column", gap: 6 }}>
          <textarea rows={2} placeholder="Address" value={f.address} onChange={set("address")} style={{ ...IN, resize: "vertical" }} />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input placeholder="Phone" value={f.phone} onChange={set("phone")} style={IN} />
            <input placeholder="Email" value={f.email} onChange={set("email")} style={IN} />
            <input placeholder="Tax no (VAT / TRN / GST)" value={f.tax_id} onChange={set("tax_id")} style={IN} />
          </div>
          <div><Button kind="primary" onClick={() => save(f)}>Save details</Button></div>
        </div>
      </div>
    </details>
  );
}
