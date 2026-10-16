"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ErrorState, Field, Input, Lozenge, Modal, PageHeader, Skeleton, Tabs, useDialogs, useFlags, Select } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import * as R from "@/lib/services/reports";
import ReportsNav from "./ReportsNav";

/* Client invoices (admin): list by state, create a draft from certified tasks —
   optionally narrowed to sub-projects, people and tasks, in a chosen currency,
   billed per hour or per task type. */
const selStyle = { border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" };
const BLANK = { client: "", title: "", from: "", to: "", currency: "", billing: "hourly", rate: "", req: "", upt: "", bug: "", incReq: true, incUpt: true, incBug: true };const blockTone = { signoff: "paused", progress: "progress", invoiced: "neutral" };

export default function Invoices() {
  const router = useRouter();
  const flags = useFlags();
  const dialogs = useDialogs();
  const [tab, setTab] = useState("all");
  const [client, setClient] = useState("");
  const filters = useResource("/kpi_client_invoice/get_filters", {}, { ttl: 60000 });
  const list = useResource(R.INV_LIST, { status_filter: tab, client_kra_id: client ? +client : false }, { ttl: 15000 });
  const invoices = list.data?.invoices || [];
  const counts = list.data?.counts || {};
  /* The routes answer {status:false, message} on failure rather than an HTTP error. */
  const listFailed = list.data?.status === false;
  const listErr = list.error || (listFailed ? new Error(list.data.message || "Could not load the invoices.") : null);
  const filtersErr = filters.data?.status === false ? (filters.data.message || "Could not load the client list.") : "";
  const [create, setCreate] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [currencies, setCurrencies] = useState([]);
  const [subs, setSubs] = useState([]); const [subSel, setSubSel] = useState(() => new Set());
  const [pick, setPick] = useState(null); /* {users, kpis} | null while loading */
  const [userSel, setUserSel] = useState(() => new Set()); const [kpiSel, setKpiSel] = useState(() => new Set());
  const [onlyBillable, setOnlyBillable] = useState(true);
  const clients = filters.data?.clients || [];
  const chosen = clients.find((c) => String(c.id) === String(form.client));

  useEffect(() => { if (create && !currencies.length) R.fetchCurrencies().then(setCurrencies).catch(() => {}); }, [create, currencies.length]);
  /* Client → its sub-projects; a new client resets every narrower choice. */
  useEffect(() => {
    setSubs([]); setSubSel(new Set()); setUserSel(new Set()); setKpiSel(new Set());
    if (!create || !form.client) return;
    R.fetchSubKrasForClient(form.client).then(setSubs).catch(() => setSubs([]));
  }, [form.client, create]);
  /* Client + sub-projects → the people and tasks to pick from. */
  const subKey = [...subSel].sort().join(",");
  useEffect(() => {
    setPick(null);
    if (!create || !form.client) return;
    let alive = true;
    R.fetchClientUsersAndKpis(form.client, [...subSel]).then((r) => { if (alive) setPick(r?.status === false ? { users: [], kpis: [], error: r.message } : { users: r?.users || [], kpis: r?.kpis || [] }); }).catch((e) => alive && setPick({ users: [], kpis: [], error: e.message }));
    return () => { alive = false; };
  }, [form.client, subKey, create]); // eslint-disable-line react-hooks/exhaustive-deps
  /* Drop picks that fell out of scope when the sub-projects changed. */
  useEffect(() => {
    if (!pick) return;
    const u = new Set(pick.users.map((x) => x.id)), k = new Set(pick.kpis.map((x) => x.id));
    setUserSel((s) => new Set([...s].filter((id) => u.has(id))));
    setKpiSel((s) => new Set([...s].filter((id) => k.has(id))));
  }, [pick]);

  /* REQ / UPT / BUG to include: all three = no filter. Same rule as the server. */
  const types = [form.incReq && "REQ", form.incUpt && "UPT", form.incBug && "BUG"].filter(Boolean);
  const typeAllowed = (k) => types.length >= 3 || types.includes((k.task_type || "").toUpperCase());
  const inType = useMemo(() => (pick?.kpis || []).filter(typeAllowed), [pick, types.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const kpis = useMemo(() => inType.filter((k) => !onlyBillable || k.billable || kpiSel.has(k.id)), [inType, onlyBillable, kpiSel]);
  const billableCount = inType.filter((k) => k.billable).length;
  /* Only ticks still on screen and still billable narrow the invoice. */
  const tickedBillable = inType.filter((k) => k.billable && kpiSel.has(k.id)).map((k) => k.id);
  const toggle = (setter, id) => setter((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const open = () => { setForm(BLANK); setOnlyBillable(true); setCreate(true); };

  const doCreate = async () => {
    if (busy) return;
    if (!form.client) { flags.err("Pick a client."); return; }
    if (!types.length) { flags.err("REQ, UPT and BUG are all unticked, so there is nothing left to bill. Tick at least one task type."); return; }
    /* A deliberate 0 is a time-only record, so this asks rather than blocks. */
    if (form.billing === "hourly" && !(Number(form.rate) > 0)
      && !(await dialogs.confirm({ title: "Per-hour rate is 0", text: "This invoice will total 0 no matter how many hours it bills. That is right for a time-only record you are sending for information. If you meant to charge for this work, set a rate first.", confirmLabel: "Create it anyway" }))) return;
    setBusy(true);
    try {
      const p = {
        client_kra_id: +form.client, invoice_title: form.title || "", from_date: form.from || "2000-01-01", to_date: form.to || "2099-12-31",
        filter_sub_kra_ids: [...subSel], filter_user_ids: [...userSel], filter_kpi_ids: tickedBillable, billing_method: form.billing,
        task_types: types.length < 3 ? types : [],
      };
      if (form.currency) p.currency_id = +form.currency;
      if (form.billing === "hourly") { if (form.rate !== "") p.hourly_rate = +form.rate || 0; }
      else { p.price_req = +form.req || 0; p.price_upt = +form.upt || 0; p.price_bug = +form.bug || 0; }
      const r = await R.createInvoice(p);
      R.assertOk(r, "Could not create the invoice.");
      const empty = !(r.data?.lines || []).length;
      const newId = r.invoice_id || r.id || r.data?.id;
      if (empty && (r.data?.empty_reasons || []).length) {
        flags.warn("Created, but nothing was billable — the reasons are on the invoice.", { ttl: 8000 });
        try { sessionStorage.setItem(R.invoiceEmptyKey(newId), JSON.stringify(r.data.empty_reasons)); } catch (e) { /* the toast still said it */ }
      } else flags.ok(`${r.data?.name || "Invoice"} created as a draft.`);
      R.invalidateInvoices(); setCreate(false);
      router.push(`/reports/invoices/${newId}`);
    } catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader crumbs={[{ label: "Reports" }, { label: "Client invoices" }]} title="Client invoices">
        <span className="input" style={{ height: 32 }}><Select value={client} onChange={(e) => setClient(e.target.value)} style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit" }}><option value="">All clients</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></span>
        <Button kind="primary" icon="plus" onClick={open}>New invoice</Button>
      </PageHeader>
      <div className="page">
        <ReportsNav />
        <Tabs items={[["all", "All"], ["draft", "Draft"], ["finalized", "Finalized"], ["sent", "Sent"], ["due", "Due"], ["claimed", "Claimed paid"], ["paid", "Paid"]].map(([k, l]) => ({ key: k, label: l, count: counts[k] }))} value={tab} onChange={setTab} />
        {filtersErr && <span className="mini" style={{ color: "var(--danger)" }}>{filtersErr}</span>}
        {listErr && (!list.data || listFailed) && <ErrorState error={listErr} onRetry={list.refresh} />}
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {!list.data && !listErr ? <div style={{ padding: 16 }}><Skeleton rows={6} /></div> : listFailed ? null : (
            <table className="table">
              <thead><tr><th>Invoice</th><th>Title</th><th>Client</th><th>Period</th><th className="num">Lines</th><th className="num">Hours</th><th className="num">Amount</th><th>Status</th><th></th></tr></thead>
              <tbody>{invoices.map((inv) => (
                <tr key={inv.id} style={{ cursor: "pointer" }} onClick={() => router.push(`/reports/invoices/${inv.id}`)}>
                  <td><b>{inv.name}</b>{inv.revision_count > 0 && <span className="mini"> · rev {inv.revision_count}</span>}</td><td>{inv.invoice_title || "—"}</td><td>{inv.client_name}{inv.parent_name ? <span className="mini"> · {inv.parent_name}</span> : null}</td><td>{inv.from_date} – {inv.to_date}</td>
                  <td className="num">{inv.line_count}</td><td className="num">{inv.grand_total_hours}h</td><td className="num"><b>{R.money(inv.total_amount, R.invSymbol(inv))}</b></td>
                  <td><Lozenge tone={R.invTone(inv)}>{R.invLabel(inv)}</Lozenge>{inv.unpaid_reason && <div className="mini" style={{ color: "var(--danger)" }} title={inv.unpaid_reason}>↺ Payment reversed</div>}</td>
                  <td><Button size="sm" onClick={(e) => { e.stopPropagation(); router.push(`/reports/invoices/${inv.id}`); }}>Open</Button></td>
                </tr>
              ))}{list.data && !invoices.length && <tr><td colSpan={9} className="empty">No invoices in this tab.</td></tr>}</tbody>
            </table>
          )}
        </div>
      </div>
      <Modal open={create} onClose={() => setCreate(false)} title="New invoice" width={720}
        footer={<><Button kind="ghost" onClick={() => setCreate(false)}>Cancel</Button><Button kind="primary" busy={busy} onClick={doCreate}>Create draft</Button></>}>
        <p className="note" style={{ margin: 0 }}>Signed-off tasks of the client that are not on an invoice yet become its lines. Narrow by dates, sub-projects, people or tasks if you like — leaving a list empty means all.</p>
        <div className="grid2">
          <Field label="Client" hint={chosen ? `${chosen.billable_count ?? 0} billable of ${chosen.task_count ?? 0} tasks${chosen.has_client_user === false ? " · no client user assigned" : ""}` : undefined}>
            <span className="input"><Select value={form.client} onChange={(e) => setForm({ ...form, client: e.target.value })} style={selStyle}><option value="">Choose a client</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.billable_count ? ` · ${c.billable_count} billable` : ""}</option>)}</Select></span>
          </Field>
          <Field label="Title (optional)"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. October 2026" /></Field>
        </div>
        <div className="grid3" style={{ gap: 10 }}>
          <Field label="From"><Input type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} /></Field>
          <Field label="To"><Input type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} /></Field>
          <Field label="Currency" hint={!form.currency ? "Blank = the client's currency" : undefined}>
            <span className="input"><Select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} style={selStyle}><option value="">Client default</option>{currencies.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.symbol})</option>)}</Select></span>
          </Field>
        </div>
        <div className="grid3" style={{ gap: 10, alignItems: "end" }}>
          <Field label="Billing"><span className="input"><Select value={form.billing} onChange={(e) => setForm({ ...form, billing: e.target.value })} style={selStyle}><option value="hourly">Per hour</option><option value="per_task">Per task by type</option></Select></span></Field>
          {form.billing === "hourly"
            ? <Field label="Hourly rate" hint="Blank = 0 (a time-only invoice)"><Input type="number" min="0" step="1" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} /></Field>
            : <div className="grid3" style={{ gap: 6, gridColumn: "span 2" }}>
                <Field label="REQ price"><Input type="number" min="0" value={form.req} onChange={(e) => setForm({ ...form, req: e.target.value })} /></Field>
                <Field label="UPT price"><Input type="number" min="0" value={form.upt} onChange={(e) => setForm({ ...form, upt: e.target.value })} /></Field>
                <Field label="BUG price"><Input type="number" min="0" value={form.bug} onChange={(e) => setForm({ ...form, bug: e.target.value })} /></Field>
              </div>}
        </div>
        <Field label="Include task types" hint={!types.length ? "Tick at least one — otherwise there is nothing to bill." : undefined}>
          <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
            {[["incReq", "REQ", "Requirements", "review"], ["incUpt", "UPT", "Updates / Amendments", "progress"], ["incBug", "BUG", "Bug fixes", "danger"]].map(([k, code, l, tone]) => (
              <label key={k} className="chk" style={{ fontSize: 13 }}><input type="checkbox" checked={!!form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.checked })} /><Lozenge tone={tone}>{code}</Lozenge>{l}</label>
            ))}
          </div>
        </Field>
        {form.client && (
          <>
            <Field label={`Sub-projects ${subSel.size ? `(${subSel.size})` : "(all)"}`}>
              <div className="chips">{subs.map((s) => <button key={s.id} type="button" className={`pill ${subSel.has(s.id) ? "on" : ""}`} style={{ height: 28, fontSize: 12 }} onClick={() => toggle(setSubSel, s.id)}>{s.name}</button>)}{!subs.length && <span className="mini">No sub-projects.</span>}</div>
            </Field>
            {!pick ? <Skeleton rows={3} /> : (
              <>
                {pick.error && <span className="mini" style={{ color: "var(--danger)" }}>{pick.error}</span>}
                <Field label={`People ${userSel.size ? `(${userSel.size})` : "(all)"}`}>
                  <div className="chips">{pick.users.map((u) => <button key={u.id} type="button" className={`pill ${userSel.has(u.id) ? "on" : ""}`} style={{ height: 28, fontSize: 12 }} onClick={() => toggle(setUserSel, u.id)}>{u.name}</button>)}{!pick.users.length && <span className="mini">Nobody has worked on this client yet.</span>}</div>
                </Field>
                <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                  <b style={{ fontSize: 13, color: "var(--navy)" }}>Tasks {kpiSel.size ? `(${kpiSel.size} picked)` : "(all billable)"} <span className="mini">· {billableCount} billable of {inType.length}{types.length < 3 ? ` (${types.join(" / ") || "no"} types)` : ""}</span></b>
                  <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <label className="chk" style={{ fontSize: 12.5 }}><span className={`toggle ${onlyBillable ? "on" : ""}`} onClick={() => setOnlyBillable((v) => !v)} style={{ cursor: "pointer" }} />Billable only</label>
                    <Button size="sm" kind="ghost" onClick={() => setKpiSel(new Set(inType.filter((k) => k.billable).map((k) => k.id)))} disabled={!billableCount}>Pick all billable</Button>
                    {kpiSel.size > 0 && <Button size="sm" kind="ghost" onClick={() => setKpiSel(new Set())}>Clear</Button>}
                  </span>
                </div>
                <div className="table-scroll" style={{ maxHeight: 240, border: "1px solid var(--border)", borderRadius: 8 }}>
                  <table className="table">
                    <tbody>
                      {kpis.map((k) => (
                        <tr key={k.id} style={{ cursor: k.billable ? "pointer" : "default", opacity: k.billable ? 1 : 0.6 }} onClick={() => k.billable && toggle(setKpiSel, k.id)}>
                          <td style={{ width: 28 }}>{k.billable ? <input type="checkbox" readOnly checked={kpiSel.has(k.id)} aria-label={`Pick ${k.name}`} /> : null}</td>
                          <td>{k.task_type && <span className="ref">{k.task_type}</span>} <b>{k.name}</b><div className="mini">{k.kra_name}</div></td>
                          <td style={{ textAlign: "right" }}>{k.billable ? <Lozenge tone="done">Billable</Lozenge> : <Lozenge tone={blockTone[k.not_billable_code] || "neutral"}>{k.not_billable_reason || "Not billable"}</Lozenge>}</td>
                        </tr>
                      ))}
                      {!kpis.length && <tr><td colSpan={3} className="empty">{onlyBillable ? "Nothing billable here yet — turn off \"Billable only\" to see why." : "No tasks."}</td></tr>}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </Modal>
    </>
  );
}
