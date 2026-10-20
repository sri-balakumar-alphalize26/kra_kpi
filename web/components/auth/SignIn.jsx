"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { roleHome } from "@/lib/cookies";
import { Button, Icon, Select } from "@/components/ui";
import Hero from "./Hero";

/* Sign in — the mobile app's flow in the browser, no tabs, as on the phone:
   Setup:   first time on a browser, Odoo login + password (the phone's device
            setup). Picks the country code and locks the number login to that
            person, as on the phone.
   Number:  number → (state) → password → in.  "Forgot" → WhatsApp code → new password → in. */
async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({ ok: false, error: "Unexpected answer." }));
  return { ok: r.ok && data.ok !== false, status: r.status, ...data };
}

export default function SignIn() {
  const params = useSearchParams();
  const next = params.get("next") || "";
  const [cfg, setCfg] = useState(null); /* { dial, length, setupName } */
  const [setupAgain, setSetupAgain] = useState(false);
  const loadCfg = () => fetch("/api/auth/config").then((r) => r.json())
    .then((c) => setCfg(c?.dial ? c : { dial: "91", length: 10, setupName: "" }))
    .catch(() => setCfg({ dial: "91", length: 10, setupName: "" }));
  useEffect(() => { loadCfg(); }, []);

  const go = (me) => { location.href = next && next.startsWith("/") ? next : roleHome(me?.role); };
  const needSetup = cfg && (!cfg.setupName || setupAgain);

  return (
    <div className="k-login">
      <section className="brand">
        <Hero />
      </section>
      <section className="lside">
        {!cfg ? null
          : needSetup ? <SetupFlow cfg={cfg} again={!!cfg.setupName} onCancel={cfg.setupName ? () => setSetupAgain(false) : null}
              onDone={() => { setSetupAgain(false); setCfg(null); loadCfg(); }} />
          : <MobileFlow cfg={cfg} onDone={go} onSetupAgain={() => setSetupAgain(true)} />}
      </section>
    </div>
  );
}

/* The phone's device setup (Connect screen), for a browser: server URL →
   its databases are fetched → pick one → Odoo login + password. */
function SetupFlow({ cfg, again, onDone, onCancel }) {
  const [url, setUrl] = useState(cfg.serverUrl || "");
  const [dbs, setDbs] = useState([]);
  const [fetchedFor, setFetchedFor] = useState("");
  const [db, setDb] = useState("");
  const [loadingDbs, setLoadingDbs] = useState(false);
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const fetchDbs = async (u = url) => {
    const want = u.trim();
    if (!want || (want === fetchedFor && dbs.length)) return;
    setErr(""); setLoadingDbs(true); setDbs([]); setDb("");
    const r = await post("/api/auth/databases", { url: want });
    setLoadingDbs(false);
    if (!r.ok) { setFetchedFor(""); setErr(r.error || "Could not fetch databases — check the URL and try again."); return; }
    setFetchedFor(want);
    setDbs(r.databases);
    /* Always chosen by the person, even when there is only one — as on the
       phone's Connect screen. */
    setDb("");
  };
  /* Prefilled with this browser's server: fetch its list straight away. */
  useEffect(() => { if (url) fetchDbs(url); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e) => {
    e.preventDefault(); setErr("");
    if (!url.trim()) { setErr("Enter the server URL."); return; }
    if (!db) { setErr(dbs.length ? "Choose a database." : "Fetch the databases first — check the URL."); return; }
    if (!login || !password) { setErr("Enter the Odoo login and password."); return; }
    setBusy(true);
    const r = await post("/api/auth/setup", { url: url.trim(), db, login: login.trim(), password });
    setBusy(false);
    if (!r.ok) { setErr(r.error || "Setup failed."); return; }
    onDone(r);
  };
  return (
    <form className="cardbox" onSubmit={submit}>
      <h2>{again ? "Set up this browser again" : "Set up this browser"}</h2>
      <p className="note">One time, like setting up the phone app. Use the Odoo account of the person who will use this browser. After this, the number login shows their country code and only their mobile number can sign in here.</p>
      <label className="field">Server URL
        <span className="input"><input inputMode="url" autoComplete="url" autoFocus={!url} value={url} placeholder="http://192.168.1.5:8069"
          onChange={(e) => { setUrl(e.target.value); if (e.target.value.trim() !== fetchedFor) { setDbs([]); setDb(""); } }}
          onBlur={() => fetchDbs()} onKeyDown={(e) => { if (e.key === "Enter" && !dbs.length) { e.preventDefault(); fetchDbs(); } }} aria-label="Server URL" />
          {loadingDbs && <span className="mini" style={{ whiteSpace: "nowrap" }}>Loading…</span>}</span>
      </label>
      <label className="field">
        <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>Database
          {dbs.length > 0 && <span className="mini" style={{ fontWeight: 400 }}>{dbs.length} {dbs.length === 1 ? "database" : "databases"} found</span>}</span>
        <span className="input"><Select value={db} disabled={!dbs.length} onChange={(e) => setDb(e.target.value)} placeholder={loadingDbs ? "Loading databases…" : dbs.length ? "Select the database" : "Enter the server URL first"} aria-label="Database" style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", width: "100%" }}>
          {dbs.map((d) => <option key={d} value={d}>{d}</option>)}
        </Select></span>
      </label>
      <label className="field">Odoo login or email<span className="input"><input autoComplete="username" autoFocus={!!url} value={login} onChange={(e) => setLogin(e.target.value)} aria-label="Odoo login" /></span></label>
      <label className="field">Odoo password
        <span className="input"><input type={show ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Odoo password" /><button type="button" className="icon-btn" style={{ width: 28, height: 28 }} aria-label={show ? "Hide password" : "Show password"} onClick={() => setShow((s) => !s)}><Icon n={show ? "eyeoff" : "eye"} size={18} /></button></span>
      </label>
      {err && <span className="err" role="alert">{err}</span>}
      <Button kind="primary" size="lg" type="submit" busy={busy} spinAt="end">Set up</Button>
      {onCancel && <div className="links"><button type="button" onClick={onCancel}>Back</button></div>}
    </form>
  );
}

function MobileFlow({ cfg, onDone, onSetupAgain }) {
  const [step, setStep] = useState("number"); /* number | password | otp-request | otp-verify */
  const [mobile, setMobile] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [code, setCode] = useState("");
  const [newPw, setNewPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [defaultPin, setDefaultPin] = useState(false); /* still the default 1111 */
  const digits = mobile.replace(/\D/g, "");

  const check = async (e) => {
    e.preventDefault(); setErr(""); setNote("");
    if (digits.length !== cfg.length) { setErr(`Enter your ${cfg.length}-digit mobile number.`); return; }
    setBusy(true);
    const r = await post("/api/auth/check", { mobile: digits });
    setBusy(false);
    if (!r.ok) { setErr(r.error || "Can't check that number right now."); return; }
    setName(r.name || "");
    /* ready or needs_setup → ask for the password. needs_setup means the
       password is still the default 1111 (new account or admin reset): the
       password page shows the app's red reminder until they change it. */
    setDefaultPin(r.state === "needs_setup");
    if (r.state === "ready" || r.state === "needs_setup") setStep("password");
    else if (r.state === "disabled") setErr("Your login is disabled. Contact your admin.");
    else if (r.state === "wrong_device") setErr(`This browser is set up for ${r.name || cfg.setupName}. Contact your admin.`);
    else setErr("This number isn't registered. Contact your admin.");
  };

  const login = async (e) => {
    e.preventDefault(); setErr("");
    if (!password) { setErr("Enter your password."); return; }
    setBusy(true);
    const r = await post("/api/auth/login", { mobile: digits, password, remember });
    setBusy(false);
    if (!r.ok) { setErr(r.error || "Login failed."); return; }
    onDone(r);
  };

  const requestOtp = async (e) => {
    e.preventDefault(); setErr("");
    setBusy(true);
    const r = await post("/api/auth/otp/request", { mobile: digits });
    setBusy(false);
    if (!r.ok) { setErr(r.error || "Could not send a code."); return; }
    setNote(r.sent === false ? "If this number is registered, a code has been sent on WhatsApp." : "Code sent on WhatsApp. It works for 10 minutes.");
    setStep("otp-verify");
  };

  const verifyOtp = async (e) => {
    e.preventDefault(); setErr("");
    if (code.replace(/\D/g, "").length < 4) { setErr("Enter the code from WhatsApp."); return; }
    if (newPw.length < 4) { setErr("Password must be at least 4 characters."); return; }
    setBusy(true);
    const r = await post("/api/auth/otp/verify", { mobile: digits, code: code.trim(), newPassword: newPw });
    setBusy(false);
    if (!r.ok) { setErr(r.error || "Could not verify the code."); return; }
    if (r.loggedIn === false) { setNote("Password set. Sign in with it now."); setPassword(""); setDefaultPin(false); setStep("password"); return; }
    onDone(r);
  };

  const Who = () => (
    <div className="who"><Icon n="user" size={18} /><span>+{cfg.dial} {digits}{name ? ` · ${name}` : ""}</span><button type="button" className="btn" style={{ height: 28, fontSize: 12 }} onClick={() => { setStep("number"); setErr(""); setNote(""); }}>Change</button></div>
  );

  if (step === "number") return (
    <form className="cardbox" onSubmit={check}>
      <h2>Log in to continue</h2>
      <p className="note" style={{ margin: 0 }}>Set up for <b>{cfg.setupName}</b> · <button type="button" onClick={onSetupAgain} style={{ background: "none", border: 0, padding: 0, color: "var(--brand)", cursor: "pointer", font: "inherit", textDecoration: "underline" }}>Set up again</button></p>
      <label className="field">Mobile number
        <span className="input"><b className="dial">+{cfg.dial}</b><input inputMode="numeric" autoComplete="tel-national" autoFocus value={mobile} maxLength={cfg.length} onChange={(e) => setMobile(e.target.value.replace(/\D/g, "").slice(0, cfg.length))} placeholder={"9".repeat(Math.min(cfg.length, 10)).replace(/(\d{5})(\d+)/, "$1 $2")} aria-label="Mobile number" /></span>
      </label>
      {err && <span className="err" role="alert">{err}</span>}
      <Button kind="primary" size="lg" type="submit" busy={busy} spinAt="end">Continue</Button>
      <div className="links"><button type="button" onClick={() => { if (digits.length >= 4) { setStep("otp-request"); setErr(""); } else setErr("Enter your number first."); }}>Forgot password? Get a WhatsApp code</button><a href="#help" onClick={(e) => { e.preventDefault(); setErr("Ask your admin to enable your login in Login management."); }}>Can't log in?</a></div>
    </form>
  );

  if (step === "password") return (
    <form className="cardbox" onSubmit={login}>
      <h2>Welcome{name ? `, ${name.split(" ")[0]}` : ""}</h2>
      <Who />
      {defaultPin && (
        <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 8, background: "color-mix(in srgb, var(--danger) 9%, transparent)", border: "1px solid var(--danger)", borderRadius: 12, padding: "10px 12px", color: "var(--danger)", fontSize: 13, lineHeight: "18px", fontWeight: 600 }}>
          <Icon n="warn" size={16} />
          <span>Your password is still the default <b style={{ fontWeight: 800 }}>1111</b>. Please change it — click “Forgot password?” below to set your own.</span>
        </div>
      )}
      {note && <p className="note">{note}</p>}
      <label className="field">Password
        <span className="input"><input type={show ? "text" : "password"} autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" /><button type="button" className="icon-btn" style={{ width: 28, height: 28 }} aria-label={show ? "Hide password" : "Show password"} onClick={() => setShow((s) => !s)}><Icon n={show ? "eyeoff" : "eye"} size={18} /></button></span>
      </label>
      <label className="chk"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} style={{ width: 16, height: 16, accentColor: "var(--brand)" }} />Keep me signed in on this computer</label>
      {err && <span className="err" role="alert">{err}</span>}
      <Button kind="primary" size="lg" type="submit" busy={busy} spinAt="end">Log in</Button>
      <div className="links"><button type="button" onClick={() => { setStep("otp-request"); setErr(""); }}>Forgot password? Get a WhatsApp code</button></div>
    </form>
  );

  if (step === "otp-request") return (
    <form className="cardbox" onSubmit={requestOtp}>
      <h2>Get a WhatsApp code</h2>
      <Who />
      <p className="note">{note || "We'll send a one-time code to this number on WhatsApp. Then you choose a new password."}</p>
      {err && <span className="err" role="alert">{err}</span>}
      <Button kind="primary" size="lg" type="submit" busy={busy} spinAt="end">Send code</Button>
      <div className="links"><button type="button" onClick={() => setStep(name ? "password" : "number")}>Back</button></div>
    </form>
  );

  return (
    <form className="cardbox" onSubmit={verifyOtp}>
      <h2>Enter the code</h2>
      <Who />
      {note && <p className="note">{note}</p>}
      <label className="field">Code from WhatsApp<span className="input"><input inputMode="numeric" autoFocus value={code} onChange={(e) => setCode(e.target.value)} aria-label="Code" /></span></label>
      <label className="field">New password<span className="input"><input type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} aria-label="New password" /></span></label>
      {err && <span className="err" role="alert">{err}</span>}
      <Button kind="primary" size="lg" type="submit" busy={busy} spinAt="end">Set password and log in</Button>
      <div className="links"><button type="button" onClick={requestOtp} disabled={busy}>Send the code again</button><button type="button" onClick={() => setStep("number")}>Back</button></div>
    </form>
  );
}
