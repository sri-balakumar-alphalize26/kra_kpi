"use client";
import { useEffect, useRef, useState } from "react";
import { Avatar, Button, ErrorState, Field, Lozenge, PageHeader, Skeleton, useDialogs, useFlags, Select } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import * as S from "@/lib/services/settings";
import { checkMobile, maxLen, placeholderFor, ruleText } from "@/lib/phone";
import SettingsNav from "./SettingsNav";

/* The ISO country of a row's number: the person's own country, else the
   company's (the one whose dial code is the company default). */
function rowCountry(u, a) {
  const list = a?.countries || [];
  const own = u.country_id && list.find((c) => c.id === u.country_id);
  const co = own || list.find((c) => String(c.phone_code) === String(a?.dial || ""));
  return { iso: co?.code || "", name: co?.name || "" };
}

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
  /* The row whose country just changed: its mobile box comes back empty and focused. */
  const [focusRow, setFocusRow] = useState(0);

  /* WhatsApp sender: connect → poll status for the QR until connected. */
  useEffect(() => {
    if (!wa?.session_id || wa.state === "connected") return;
    const id = setInterval(async () => { try { const r = await S.waStatus(wa.session_id); if (r?.status !== false) setWa({ ...r, session_id: wa.session_id }); if (r?.state === "connected") { flags.ok("WhatsApp connected."); refresh(); } } catch (_) {} }, 3000);
    return () => clearInterval(id);
  }, [wa]); // eslint-disable-line react-hooks/exhaustive-deps
  const connect = async () => { const r = await run("wa", () => S.waConnect()); if (r?.session_id) setWa({ ...r }); };
  const disconnect = async () => { if (!(await dlg.confirm({ title: "Disconnect WhatsApp?", text: "Login codes and approvals stop being sent until it is reconnected.", confirmLabel: "Disconnect", danger: true }))) return; await run("wa", () => S.waDelete(a.wa_session_id || wa?.session_id), "Disconnected."); setWa(null); };
  const state = wa?.state || a?.wa_state;

  /* The WhatsApp side panel (UltraViewer-style): tucked behind a tab on the
     right edge so the users table gets the width; remembered per browser. */
  const [panel, setPanel] = useState(false);
  useEffect(() => { try { setPanel(localStorage.getItem("kpi.lm.panel") === "1"); } catch (e) {} }, []);
  const showPanel = (v) => { setPanel(v); try { localStorage.setItem("kpi.lm.panel", v ? "1" : "0"); } catch (e) {} };
  /* A QR being shown must not be hidden behind the tab. */
  useEffect(() => { if (wa?.qr_image && wa?.state !== "connected") setPanel(true); }, [wa?.qr_image, wa?.state]);
  useEffect(() => {
    if (!panel) return;
    const onKey = (e) => { if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".overlay")) showPanel(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel]);
  const waTone = state === "connected" ? "on" : state && state !== "none" ? "wait" : "off";
  const preview = (tpl || "").replace(/\{name\}/g, "Arun").replace(/\{code\}/g, "482913").replace(/\{minutes\}/g, String(a?.otp_minutes || 10)).replace(/\{app\}/g, a?.app_name || "KRA KPI");

  return (
    <>
      <PageHeader crumbs={[{ label: "Settings" }, { label: "Login management" }]} title="Login management" meta="Who can sign in with a mobile number, and the WhatsApp sender for codes" />
      <SettingsNav />
      <div className={`lm-wrap ${panel ? "open" : ""}`}>
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {(refused || (access.error && !a)) && <div style={{ padding: 16 }}><ErrorState error={refused || access.error} onRetry={access.refresh} /></div>}
          {!a ? (refused || access.error ? null : <div style={{ padding: 16 }}><Skeleton rows={6} /></div>) : (
            <table className="table">
              <thead><tr><th>User</th><th>Role</th><th>Mobile</th><th>Country</th><th>App login</th><th>Last sign-in</th><th></th></tr></thead>
              <tbody>
                {users.map((u) => { const rc = rowCountry(u, a); return (
                  <tr key={u.id}>
                    <td><Avatar name={u.name} uid={u.id} size={24} /> <b>{u.name}</b>{u.active === false && <> <Lozenge tone="todo">Archived</Lozenge></>}</td>
                    <td><span className="input" style={{ height: 28 }}><Select value={u.role || "developer"} disabled={u.is_system} onChange={(e) => run(`r${u.id}`, () => S.setUserRole(u.id, e.target.value), "Role changed.")} style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit" }}>{S.ROLES.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}</Select></span></td>
                    <td><MobileCell key={`${u.id}-${rc.iso}-${u.mobile || ""}`} u={u} iso={rc.iso} countryName={rc.name} autoFocus={focusRow === u.id}
                      onSave={(m) => run(`m${u.id}`, () => S.setUserMobile(u.id, m), m ? "Mobile saved." : "Mobile cleared.")} /></td>
                    <td><span className="input" style={{ height: 28 }}><Select value={u.country_id || ""} onChange={async (e) => {
                      const r = await run(`c${u.id}`, () => S.setUserCountry(u.id, +e.target.value || false));
                      if (!r) return;
                      /* A number belongs to the country that issued it: the server
                         cleared it, so the box comes back empty, focused, and
                         checking against the new country's rule. */
                      setFocusRow(u.id);
                      const nc = rowCountry({ ...u, country_id: r.country_id || false }, a);
                      flags.ok(r.cleared?.length
                        ? `Country saved. ${r.cleared.map((k) => (k === "whatsapp" ? "WhatsApp number" : "Mobile")).join(" and ")} cleared — enter the ${nc.name || "new"} number.`
                        : `Country saved — enter the ${nc.name || "new"} number.`);
                    }} style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit" }}><option value="">Company (+{a?.dial || "91"})</option>{(a?.countries || []).map((c) => <option key={c.id} value={c.id}>{c.code} +{c.phone_code}</option>)}</Select></span></td>
                    <td><span className={`toggle ${u.enabled ? "on" : ""}`} role="switch" aria-checked={!!u.enabled} onClick={() => run(`t${u.id}`, () => S.toggleLogin(u.id, !u.enabled), u.enabled ? "Login disabled." : "Login enabled.")} style={{ cursor: "pointer" }} /></td>
                    <td className="mini">{u.last_login || "never"}{u.last_device ? ` · ${u.last_device}` : ""}{u.has_password === false && <> <span title="No app password yet: Reset password sets it to 1111"><Lozenge tone="paused" style={{ textTransform: "none" }}>No app password</Lozenge></span></>}</td>
                    <td><Button size="sm" busy={busy === `p${u.id}`} onClick={async () => { if (await dlg.confirm({ title: "Reset password?", text: `${u.name}'s password will be reset to 1111.`, confirmLabel: "Reset password", danger: true })) run(`p${u.id}`, () => S.resetPassword(u.id), "Reset to 1111."); }}>Reset password</Button></td>
                  </tr>
                ); })}
              </tbody>
            </table>
          )}
          <div className="empty" style={{ padding: 12 }}>New users sign in with password <b>1111</b> and must change it on first login · 5 wrong attempts lock the number for 15 min.</div>
        </div>
        <button type="button" className="lm-tab" aria-expanded={panel} aria-controls="lm-panel"
          title={panel ? "Hide WhatsApp sender" : "Show WhatsApp sender & OTP message"} onClick={() => showPanel(!panel)}>
          <span className="lm-arrow" aria-hidden="true">{panel ? "▶" : "◀"}</span>
          <span className="lm-label">WhatsApp</span>
          <span className={`lm-dot ${waTone}`} aria-label={state === "connected" ? "connected" : "not connected"} />
        </button>
        {panel && <div className="lm-backdrop" onClick={() => showPanel(false)} aria-hidden="true" />}
        <aside id="lm-panel" className="lm-panel" aria-hidden={!panel} inert={!panel}>
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
        </aside>
      </div>
    </>
  );
}

/* The login mobile, checked with Google's libphonenumber for the row's
   country (India: 10 digits starting 6-9; Oman: 8 digits starting 7 or 9).
   Only a valid number (or an empty box, which clears it) is saved; the
   server checks again. Remounted (key) when the country or saved number
   changes, so a country change starts from an empty box. */
function MobileCell({ u, iso, countryName, autoFocus, onSave }) {
  const [v, setV] = useState(u.mobile || "");
  const [bad, setBad] = useState(false);
  const ref = useRef(null);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  const cap = iso ? maxLen(iso) : 15;
  const commit = () => {
    if (v === (u.mobile || "")) { setBad(false); return; }
    const c = checkMobile(v, iso);
    setBad(!c.ok);
    if (c.ok) onSave(c.national);
  };
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 3 }}>
      <span className="input" style={{ height: 28, width: 160, ...(bad ? { borderColor: "var(--danger)", boxShadow: "0 0 0 1px var(--danger)" } : null) }}>
        <span className="ph">+{u.dial || "91"}</span>
        <input ref={ref} inputMode="numeric" value={v} maxLength={cap} aria-invalid={bad} aria-label={`Mobile for ${u.name}`}
          onChange={(e) => { setV(e.target.value.replace(/\D/g, "").slice(0, cap)); if (bad) setBad(false); }}
          onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          placeholder={iso ? `e.g. ${placeholderFor(iso)}` : "no mobile"}
          style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }} />
      </span>
      {bad && <span role="alert" style={{ color: "var(--danger)", fontSize: 11.5, lineHeight: "15px", maxWidth: 220 }}>{ruleText(iso, countryName)}</span>}
    </span>
  );
}
