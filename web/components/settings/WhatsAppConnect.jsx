"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, ErrorState, Field, Icon, Input, Lozenge, Modal, PageHeader, Skeleton, useDialogs, useFlags } from "@/components/ui";
import * as S from "@/lib/services/settings";
import SettingsNav from "./SettingsNav";

/* Setup › WhatsApp Connect: the whatsapp.session form from the whatsapp_neonize
   addon (Odoo's menu opens that addon's own action). Connect shows a QR to
   scan; Disconnect stops the client but KEEPS the session and its message
   history (unlike Login management's "Disconnect", which resets the record);
   Refresh status re-reads the live state; Send message and the message log
   with its count. Everything is plain call_kw, so Odoo's WhatsApp groups decide
   who may do what. */
const STATUS = { connected: ["done", "Connected"], waiting_qr: ["paused", "Scan QR code"], disconnected: ["todo", "Disconnected"], error: ["danger", "Error"] };
const local = (ts) => { if (!ts) return "—"; const d = new Date(String(ts).replace(" ", "T") + "Z"); return Number.isNaN(+d) ? ts : d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); };

export default function WhatsAppConnect() {
  const flags = useFlags();
  const dlg = useDialogs();
  const [sessions, setSessions] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState(null);
  const [qr, setQr] = useState("");
  const [msgs, setMsgs] = useState(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState("");
  const [send, setSend] = useState(null); /* {phone, message} */

  const load = useCallback(async () => {
    try {
      const rows = (await S.listWaSessions()) || [];
      setSessions(rows); setErr(null);
      setSel((cur) => (rows.some((r) => r.id === cur) ? cur : rows[0]?.id ?? null));
    } catch (e) { setErr(e); setSessions((s) => s || []); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const s = (sessions || []).find((x) => x.id === sel) || null;

  const loadMsgs = useCallback(async () => {
    if (!sel) { setMsgs([]); return; }
    try { setMsgs((await S.listWaMessages(sel)) || []); } catch (e) { setMsgs([]); flags.err(e.message); }
  }, [sel, flags]);
  useEffect(() => { setMsgs(null); loadMsgs(); }, [loadMsgs]);

  /* While a QR is up, re-read the record (the QR rotates; the connect callback
     writes the new state) every 4 s. Read-only on purpose: action_refresh_status
     copies one worker's in-memory state over the record, so it stays a button. */
  useEffect(() => {
    if (!s || s.status !== "waiting_qr") { setQr(""); return; }
    let alive = true;
    const tick = async () => {
      try {
        const r = await S.readWaQr(s.id);
        if (!alive) return;
        setQr(r?.status === "waiting_qr" && r.qr_image ? String(r.qr_image) : "");
        if (r?.status && r.status !== "waiting_qr") { load(); if (r.status === "connected") flags.ok("WhatsApp connected."); }
      } catch (_) { /* keep the last QR */ }
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [s?.id, s?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (key, fn, ok) => {
    setBusy(key);
    try { await fn(); if (ok) flags.ok(ok); await load(); }
    catch (e) { flags.err(e.message); } finally { setBusy(""); }
  };
  const connect = () => act("connect", () => S.waSessionConnect(s.id), "Connecting… scan the QR when it appears.");
  const refresh = () => act("refresh", async () => { await S.waSessionRefresh(s.id); await loadMsgs(); }, "Status refreshed.");
  const disconnect = async () => {
    if (!(await dlg.confirm({ title: "Disconnect WhatsApp?", text: `"${s.name}" stops sending and receiving until it is connected again. The session and its ${s.message_count || 0} messages are kept.`, confirmLabel: "Disconnect", danger: true }))) return;
    act("disconnect", () => S.waSessionDisconnect(s.id), "Disconnected.");
  };
  const doSend = async () => {
    const phone = send.phone.replace(/[^\d]/g, "");
    if (!phone || !send.message.trim()) return;
    setBusy("send");
    try { await S.waSessionSend(s.id, phone, send.message.trim()); flags.ok("Message sent."); setSend(null); await load(); await loadMsgs(); }
    catch (e) { flags.err(e.message); await loadMsgs(); } finally { setBusy(""); }
  };

  const ql = q.trim().toLowerCase();
  const shown = useMemo(() => (msgs || []).filter((m) => !ql || [m.phone, m.message, Array.isArray(m.partner_id) ? m.partner_id[1] : ""].some((v) => String(v || "").toLowerCase().includes(ql))), [msgs, ql]);
  const [tone, label] = STATUS[s?.status] || ["todo", s?.status || "—"];

  return (
    <>
      <PageHeader crumbs={[{ label: "Settings" }, { label: "WhatsApp connect" }]} title="WhatsApp connect" meta="The WhatsApp session that sends codes, approvals and reports">
        {s && <Button icon="swap" kind="ghost" busy={busy === "refresh"} onClick={refresh}>Refresh status</Button>}
      </PageHeader>
      <SettingsNav />
      <div className="page">
        {err && <ErrorState error={err} onRetry={load} title="Couldn't read the WhatsApp session" />}
        {!sessions && !err && <div className="cardbox"><Skeleton rows={4} /></div>}
        {sessions && !sessions.length && !err && <div className="cardbox"><span className="mini">No WhatsApp session yet. Connect one from Settings › Login management (Connect, show QR).</span></div>}
        {sessions?.length > 1 && (
          <div className="pillset">{sessions.map((x) => <button key={x.id} type="button" className={`pill ${x.id === sel ? "on" : ""}`} onClick={() => setSel(x.id)}>{x.name}{x.phone_number ? ` · +${x.phone_number}` : ""}</button>)}</div>
        )}
        {s && (
          <div className="g21" style={{ alignItems: "start" }}>
            <div className="cardbox table-scroll" style={{ padding: 0 }}>
              <h2 style={{ padding: "14px 16px 0" }}>Messages <small>{s.message_count || 0} in total{msgs && msgs.length < (s.message_count || 0) ? ` · newest ${msgs.length} shown` : ""}</small>
                <span className="right"><Input icon="search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Phone, contact or text" aria-label="Filter messages" style={{ width: 220 }} /></span>
              </h2>
              {!msgs ? <div style={{ padding: 16 }}><Skeleton rows={6} /></div> : (
                <table className="table" style={{ marginTop: 8 }}>
                  <thead><tr><th>Time</th><th>Direction</th><th>Phone</th><th>Contact</th><th style={{ width: "40%" }}>Message</th><th>Status</th></tr></thead>
                  <tbody>
                    {shown.map((m) => (
                      <tr key={m.id}>
                        <td className="mini">{local(m.create_date)}</td>
                        <td>{m.direction === "incoming" ? <Lozenge tone="progress">In</Lozenge> : <Lozenge tone="neutral">Out</Lozenge>}</td>
                        <td className="mini">{m.phone || "—"}</td>
                        <td>{Array.isArray(m.partner_id) ? m.partner_id[1] : <span className="mini">—</span>}</td>
                        <td style={{ whiteSpace: "pre-wrap", maxWidth: 420 }}>{m.message || <span className="mini">(no text)</span>}</td>
                        <td>{m.status === "failed" ? <Lozenge tone="danger">Failed</Lozenge> : <Lozenge tone={m.status === "read" || m.status === "delivered" ? "done" : "todo"}>{m.status || "—"}</Lozenge>}</td>
                      </tr>
                    ))}
                    {!shown.length && <tr><td colSpan={6} className="empty">{msgs.length ? "No message matches the filter." : "No messages yet."}</td></tr>}
                  </tbody>
                </table>
              )}
            </div>
            <div className="cardbox">
              <h2>{s.name} <Lozenge tone={tone}>{label}</Lozenge></h2>
              <div className="kv"><span className="lbl">Connected phone</span><span className="val">{s.phone_number ? `+${s.phone_number}` : "—"}</span></div>
              <div className="kv"><span className="lbl">Auto reconnect</span><span className="val">{s.auto_reconnect ? "On" : "Off"}</span></div>
              <div className="kv" style={{ border: 0 }}><span className="lbl">Messages</span><span className="val">{s.message_count || 0}</span></div>
              {s.status === "waiting_qr" && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: 8 }}>
                  {qr ? <img src={`data:image/png;base64,${qr}`} alt="Scan with WhatsApp" style={{ width: 220, height: 220, borderRadius: 12, border: "6px solid #fff", boxShadow: "var(--shadow)" }} /> : <Skeleton rows={3} />}
                  <span className="mini" style={{ textAlign: "center" }}>WhatsApp on the phone › Settings › Linked devices › Link a device, then scan. The code refreshes about every 30 s; press Connect again if it expires.</span>
                </div>
              )}
              {s.status === "connected" && <div className="callout ok"><Icon n="check" size={18} />Connected. Messages can be sent and received.</div>}
              {s.status === "error" && <div className="callout" style={{ background: "var(--over-bg)", borderColor: "var(--danger)", color: "var(--over)" }}><Icon n="warn" size={18} /><span><b>Connection error</b>{s.error_message ? ` — ${s.error_message}` : ""}</span></div>}
              <div className="row" style={{ flexWrap: "wrap" }}>
                {s.status !== "connected" && <Button kind="primary" busy={busy === "connect"} onClick={connect}>{s.status === "waiting_qr" ? "New QR code" : "Connect WhatsApp"}</Button>}
                {s.status === "connected" && <Button kind="primary" icon="plus" onClick={() => setSend({ phone: "", message: "" })}>Send message</Button>}
                {s.status === "connected" && <Button kind="danger" busy={busy === "disconnect"} onClick={disconnect}>Disconnect</Button>}
              </div>
              <span className="mini">Disconnect keeps this session and its message history. To remove the connection completely, use Login management.</span>
            </div>
          </div>
        )}
      </div>
      <Modal open={!!send} onClose={() => setSend(null)} title="Send a WhatsApp message" width={480}
        footer={<><Button kind="ghost" onClick={() => setSend(null)}>Cancel</Button><Button kind="primary" busy={busy === "send"} disabled={!send?.phone.replace(/\D/g, "") || !send?.message.trim()} onClick={doSend}>Send</Button></>}>
        {send && <>
          <Field label="Phone number" hint="With the country code, digits only (e.g. 919876543210)"><Input value={send.phone} inputMode="tel" autoFocus onChange={(e) => setSend({ ...send, phone: e.target.value })} /></Field>
          <Field label="Message"><span className="input ta" style={{ height: "auto" }}><textarea rows={5} value={send.message} onChange={(e) => setSend({ ...send, message: e.target.value })} style={{ border: 0, background: "none", outline: 0, resize: "vertical", width: "100%", font: "inherit", color: "inherit" }} /></span></Field>
        </>}
      </Modal>
    </>
  );
}
