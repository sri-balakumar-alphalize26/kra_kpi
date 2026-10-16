"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { roleHome } from "@/lib/cookies";
import { Button, Icon } from "@/components/ui";
import Hero from "./Hero";

/* Sign in — the mobile app's flow in the browser:
   Mobile tab:  number → (state) → password → in.  "Forgot" → WhatsApp code → new password → in.
   Odoo tab:    Odoo login + password (admins who live in Odoo). */
async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({ ok: false, error: "Unexpected answer." }));
  return { ok: r.ok && data.ok !== false, status: r.status, ...data };
}

export default function SignIn() {
  const params = useSearchParams();
  const next = params.get("next") || "";
  const [tab, setTab] = useState("mobile");
  const [cfg, setCfg] = useState({ dial: "91", length: 10 });
  useEffect(() => { fetch("/api/auth/config").then((r) => r.json()).then((c) => c?.dial && setCfg(c)).catch(() => {}); }, []);

  const go = (me) => { location.href = next && next.startsWith("/") ? next : roleHome(me?.role); };

  return (
    <div className="k-login">
      <section className="brand">
        <Hero />
      </section>
      <section className="lside">
        {tab === "mobile" ? <MobileFlow cfg={cfg} onDone={go} switchTab={() => setTab("odoo")} /> : <OdooFlow onDone={go} switchTab={() => setTab("mobile")} />}
      </section>
    </div>
  );
}

function TabRow({ tab, onMobile, onOdoo }) {
  return (
    <div className="tabs" style={{ alignSelf: "flex-start" }} role="tablist">
      <span role="tab" className={tab === "mobile" ? "on" : ""} onClick={onMobile} style={{ cursor: "pointer" }}>Mobile number</span>
      <span role="tab" className={tab === "odoo" ? "on" : ""} onClick={onOdoo} style={{ cursor: "pointer" }}>Odoo account</span>
    </div>
  );
}

function MobileFlow({ cfg, onDone, switchTab }) {
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
  const digits = mobile.replace(/\D/g, "");

  const check = async (e) => {
    e.preventDefault(); setErr(""); setNote("");
    if (digits.length < 4) { setErr("Enter your mobile number."); return; }
    setBusy(true);
    const r = await post("/api/auth/check", { mobile: digits });
    setBusy(false);
    if (!r.ok) { setErr(r.error || "Can't check that number right now."); return; }
    setName(r.name || "");
    /* ready or needs_setup → ask for the password. needs_setup means the
       password is still the default 1111 (new account or admin reset); the
       app says so and nags to change it after login. */
    if (r.state === "ready") setStep("password");
    else if (r.state === "needs_setup") { setNote("First time here? Your password is 1111. You'll be asked to change it after you log in — or get a WhatsApp code to set your own now."); setStep("password"); }
    else if (r.state === "disabled") setErr("Your login is disabled. Contact your admin.");
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
    if (r.loggedIn === false) { setNote("Password set. Sign in with it now."); setPassword(""); setStep("password"); return; }
    onDone(r);
  };

  const Who = () => (
    <div className="who"><Icon n="user" size={18} /><span>+{cfg.dial} {digits}{name ? ` · ${name}` : ""}</span><button type="button" className="btn" style={{ height: 28, fontSize: 12 }} onClick={() => { setStep("number"); setErr(""); setNote(""); }}>Change</button></div>
  );

  if (step === "number") return (
    <form className="cardbox" onSubmit={check}>
      <h2>Log in to continue</h2>
      <TabRow tab="mobile" onMobile={() => {}} onOdoo={switchTab} />
      <label className="field">Mobile number
        <span className="input"><b className="dial">+{cfg.dial}</b><input inputMode="numeric" autoComplete="tel-national" autoFocus value={mobile} maxLength={cfg.length + 4} onChange={(e) => setMobile(e.target.value)} placeholder={"9".repeat(Math.min(cfg.length, 10)).replace(/(\d{5})(\d+)/, "$1 $2")} aria-label="Mobile number" /></span>
      </label>
      {err && <span className="err" role="alert">{err}</span>}
      <Button kind="primary" size="lg" type="submit" busy={busy}>Continue</Button>
      <div className="links"><button type="button" onClick={() => { if (digits.length >= 4) { setStep("otp-request"); setErr(""); } else setErr("Enter your number first."); }}>Forgot password? Get a WhatsApp code</button><a href="#help" onClick={(e) => { e.preventDefault(); setErr("Ask your admin to enable your login in Login management."); }}>Can't log in?</a></div>
    </form>
  );

  if (step === "password") return (
    <form className="cardbox" onSubmit={login}>
      <h2>Welcome{name ? `, ${name.split(" ")[0]}` : ""}</h2>
      <Who />
      {note && <p className="note">{note}</p>}
      <label className="field">Password
        <span className="input"><input type={show ? "text" : "password"} autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" /><button type="button" className="icon-btn" style={{ width: 28, height: 28 }} aria-label={show ? "Hide password" : "Show password"} onClick={() => setShow((s) => !s)}><Icon n={show ? "eyeoff" : "eye"} size={18} /></button></span>
      </label>
      <label className="chk"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} style={{ width: 16, height: 16, accentColor: "var(--brand)" }} />Keep me signed in on this computer</label>
      {err && <span className="err" role="alert">{err}</span>}
      <Button kind="primary" size="lg" type="submit" busy={busy}>Log in</Button>
      <div className="links"><button type="button" onClick={() => { setStep("otp-request"); setErr(""); }}>Forgot password? Get a WhatsApp code</button></div>
    </form>
  );

  if (step === "otp-request") return (
    <form className="cardbox" onSubmit={requestOtp}>
      <h2>Get a WhatsApp code</h2>
      <Who />
      <p className="note">{note || "We'll send a one-time code to this number on WhatsApp. Then you choose a new password."}</p>
      {err && <span className="err" role="alert">{err}</span>}
      <Button kind="primary" size="lg" type="submit" busy={busy}>Send code</Button>
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
      <Button kind="primary" size="lg" type="submit" busy={busy}>Set password and log in</Button>
      <div className="links"><button type="button" onClick={requestOtp} disabled={busy}>Send the code again</button><button type="button" onClick={() => setStep("number")}>Back</button></div>
    </form>
  );
}

function OdooFlow({ onDone, switchTab }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (e) => {
    e.preventDefault(); setErr("");
    if (!login || !password) { setErr("Enter your Odoo login and password."); return; }
    setBusy(true);
    const r = await post("/api/auth/odoo-login", { login: login.trim(), password, remember });
    setBusy(false);
    if (!r.ok) { setErr(r.error || "Login failed."); return; }
    onDone(r);
  };
  return (
    <form className="cardbox" onSubmit={submit}>
      <h2>Log in with your Odoo account</h2>
      <TabRow tab="odoo" onMobile={switchTab} onOdoo={() => {}} />
      <label className="field">Odoo login or email<span className="input"><input autoComplete="username" autoFocus value={login} onChange={(e) => setLogin(e.target.value)} aria-label="Odoo login" /></span></label>
      <label className="field">Password
        <span className="input"><input type={show ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" /><button type="button" className="icon-btn" style={{ width: 28, height: 28 }} aria-label={show ? "Hide password" : "Show password"} onClick={() => setShow((s) => !s)}><Icon n={show ? "eyeoff" : "eye"} size={18} /></button></span>
      </label>
      <label className="chk"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} style={{ width: 16, height: 16, accentColor: "var(--brand)" }} />Keep me signed in on this computer</label>
      {err && <span className="err" role="alert">{err}</span>}
      <Button kind="primary" size="lg" type="submit" busy={busy}>Log in</Button>
      <p className="note">For admins who use Odoo directly. Everyone else signs in with their mobile number.</p>
    </form>
  );
}
