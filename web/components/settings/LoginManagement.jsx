"use client";
import { useEffect, useState } from "react";
import { Avatar, Button, ErrorState, Field, Lozenge, PageHeader, Skeleton, useDialogs, useFlags, Select } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import * as S from "@/lib/services/settings";
import SettingsNav from "./SettingsNav";

/* Who can sign in with a mobile number, the WhatsApp sender (QR) used for
   codes and approvals, and the OTP message template. */
export default function LoginManagement() {
  const flags = useFlags();
  const dlg = useDialogs();
  const access = useResource(S.ACCESS_PATH, {}, { ttl: 10000, pollMs: 0 });
  /* {status:false, message} (not authorized) is a failure, not an empty list. */
  const refused = access.data?.status === false ? { message: access.data.message || access.data.error || "Could not load the users." } : null;
  const a = refused ? null : access.data;
  const users = a?.users || [];
  const [tpl, setTpl] = useState(null);
  const [wa, setWa] = useState(null); /* status payload */
  const [busy, setBusy] = useState("");
  useEffect(() => { if (a && tpl == null) setTpl(a.otp_template || a.otp_default || ""); }, [a, tpl]);
  const refresh = () => { S.invalidateAccess(); access.refresh(); };
  const run = async (k, fn, ok) => { setBusy(k); try { const r = await fn(); S.assertOk(r, "Refused."); if (ok) flags.ok(ok); refresh(); return r; } catch (e) { flags.err(e.message); } finally { setBusy(""); } };

  /* WhatsApp sender: connect → poll status for the QR until connected. */
  useEffect(() => {
    if (!wa?.session_id || wa.state === "connected") return;
    const id = setInterval(async () => { try { const r = await S.waStatus(wa.session_id); if (r?.status !== false) setWa({ ...r, session_id: wa.session_id }); if (r?.state === "connected") { flags.ok("WhatsApp connected."); refresh(); } } catch (_) {} }, 3000);
    return () => clearInterval(id);
  }, [wa]); // eslint-disable-line react-hooks/exhaustive-deps
  const connect = async () => { const r = await run("wa", () => S.waConnect()); if (r?.session_id) setWa({ ...r }); };
  const disconnect = async () => { if (!(await dlg.confirm({ title: "Disconnect WhatsApp?", text: "Login codes and approvals stop being sent until it is reconnected.", confirmLabel: "Disconnect", danger: true }))) return; await run("wa", () => S.waDelete(a.wa_session_id || wa?.session_id), "Disconnected."); setWa(null); };
  const state = wa?.state || a?.wa_state;
  const preview = (tpl || "").replace(/\{name\}/g, "Arun").replace(/\{code\}/g, "482913").replace(/\{minutes\}/g, String(a?.otp_minutes || 10)).replace(/\{app\}/g, a?.app_name || "KRA KPI");

  return (
    <>
      <PageHeader crumbs={[{ label: "Settings" }, { label: "Login management" }]} title="Login management" meta="Who can sign in with a mobile number, and the WhatsApp sender for codes" />
      <SettingsNav />
      <div className="g21" style={{ flex: 1, minHeight: 0 }}>
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {(refused || (access.error && !a)) && <div style={{ padding: 16 }}><ErrorState error={refused || access.error} onRetry={access.refresh} /></div>}
          {!a ? (refused || access.error ? null : <div style={{ padding: 16 }}><Skeleton rows={6} /></div>) : (
            <table className="table">
              <thead><tr><th>User</th><th>Role</th><th>Mobile</th><th>Country</th><th>App login</th><th>Last sign-in</th><th></th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td><Avatar name={u.name} id={u.id} size={24} /> <b>{u.name}</b>{u.active === false && <> <Lozenge tone="todo">Archived</Lozenge></>}</td>
                    <td><span className="input" style={{ height: 28 }}><Select value={u.role || "developer"} disabled={u.is_system} onChange={(e) => run(`r${u.id}`, () => S.setUserRole(u.id, e.target.value), "Role changed.")} style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit" }}>{S.ROLES.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}</Select></span></td>
                    <td><MobileCell u={u} onSave={(m) => run(`m${u.id}`, () => S.setUserMobile(u.id, m), "Mobile saved.")} /></td>
                    <td><span className="input" style={{ height: 28 }}><Select value={u.country_id || ""} onChange={async (e) => { const r = await run(`c${u.id}`, () => S.setUserCountry(u.id, +e.target.value || false)); if (r) flags.ok(r.cleared?.length ? `Country saved. ${r.cleared.map((k) => (k === "whatsapp" ? "WhatsApp number" : "mobile")).join(" and ")} cleared: enter ${r.cleared.length > 1 ? "them" : "it"} again for the new dial code.` : "Country saved."); }} style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit" }}><option value="">Company (+{a?.dial || "91"})</option>{(a?.countries || []).map((c) => <option key={c.id} value={c.id}>{c.code} +{c.phone_code}</option>)}</Select></span></td>
                    <td><span className={`toggle ${u.enabled ? "on" : ""}`} role="switch" aria-checked={!!u.enabled} onClick={() => run(`t${u.id}`, () => S.toggleLogin(u.id, !u.enabled), u.enabled ? "Login disabled." : "Login enabled.")} style={{ cursor: "pointer" }} /></td>
                    <td className="mini">{u.last_login || "never"}{u.last_device ? ` · ${u.last_device}` : ""}{u.has_password === false && <> <span title="No app password yet: Reset password sets it to 1111"><Lozenge tone="paused" style={{ textTransform: "none" }}>No app password</Lozenge></span></>}</td>
                    <td><Button size="sm" busy={busy === `p${u.id}`} onClick={async () => { if (await dlg.confirm({ title: "Reset password?", text: `${u.name}'s password will be reset to 1111.`, confirmLabel: "Reset password", danger: true })) run(`p${u.id}`, () => S.resetPassword(u.id), "Reset to 1111."); }}>Reset password</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="empty" style={{ padding: 12 }}>New users sign in with password <b>1111</b> and must change it on first login · 5 wrong attempts lock the number for 15 min.</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="cardbox"><h2>WhatsApp sender {state === "connected" ? <Lozenge tone="done">Connected</Lozenge> : state && state !== "none" ? <Lozenge tone="paused">{String(state).replace(/_/g, " ")}</Lozenge> : <Lozenge tone="todo">Not connected</Lozenge>}</h2>
            <div className="row" style={{ gap: 14, alignItems: "flex-start" }}>
              {wa?.qr_image && state !== "connected" ? <img src={`data:image/png;base64,${wa.qr_image}`} alt="Scan with WhatsApp" style={{ width: 150, height: 150, borderRadius: 12, border: "6px solid #fff", boxShadow: "var(--shadow)" }} /> : <div className="qr" aria-hidden="true" style={{ opacity: state === "connected" ? .25 : .5 }} />}
              <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                <b>{a?.connected_number || wa?.phone_number ? `+${a?.connected_number || wa?.phone_number}` : "No number linked"}</b>
                <span className="mini">Sends OTP codes, pre-approvals and sign-off requests.</span>
                {wa?.error && <span className="err" style={{ color: "var(--danger)", fontSize: 12.5 }}>{wa.error}</span>}
                {state !== "connected" && wa?.session_id && <span className="mini">Open WhatsApp › Linked devices › Link a device and scan.</span>}
                <div className="row" style={{ marginTop: 4 }}>
                  {state !== "connected" && <Button size="sm" kind="primary" busy={busy === "wa"} onClick={connect}>{wa?.session_id ? "New QR" : "Connect (show QR)"}</Button>}
                  {(state === "connected" || a?.wa_session_id) && <Button size="sm" kind="danger" busy={busy === "wa"} onClick={disconnect}>Disconnect</Button>}
                </div>
              </div>
            </div>
          </div>
          <div className="cardbox"><h2>OTP message</h2>
            <Field label="Template" hint="Placeholders: {name} {code} {minutes} {app}"><span className="input ta" style={{ height: 92 }}><textarea value={tpl ?? ""} onChange={(e) => setTpl(e.target.value)} style={{ border: 0, background: "none", outline: 0, resize: "none", width: "100%", height: "100%", font: "inherit", color: "inherit" }} /></span></Field>
            <div className="wa-bubble"><b style={{ color: "var(--wa-text)" }}>Preview</b><br />{preview}</div>
            <div className="row"><Button kind="primary" busy={busy === "tpl"} onClick={() => run("tpl", () => S.setOtpMessage(tpl), "Template saved.")}>Save template</Button><Button kind="ghost" onClick={() => setTpl(a?.otp_default || "")}>Reset to default</Button></div>
          </div>
        </div>
      </div>
    </>
  );
}

function MobileCell({ u, onSave }) {
  const [v, setV] = useState(u.mobile || "");
  useEffect(() => { setV(u.mobile || ""); }, [u.mobile]);
  return <span className="input" style={{ height: 28, width: 150 }}><span className="ph">+{u.dial || "91"}</span><input inputMode="numeric" value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, ""))} onBlur={() => { if (v !== (u.mobile || "")) onSave(v); }} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} placeholder="no mobile" style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }} /></span>;
}
