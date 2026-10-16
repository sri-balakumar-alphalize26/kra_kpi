"use client";
import { useCallback, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MeContext } from "@/lib/me";
import { roleHome } from "@/lib/cookies";
import { Button } from "@/components/ui";
import KraLoader from "@/components/ui/KraLoader";
import ServerDown from "@/components/ui/ServerDown";

/* Every signed-in page goes through the gate: it asks /api/auth/me once,
   provides the person to the tree (useMe), and sends people elsewhere when
   the session is gone or the area is not theirs. middleware.js only checked
   that a cookie exists (and the role cookie's hint); this is the real check.

   Nested gates (an admin-only segment inside the work area) reuse the person
   the outer gate already loaded instead of asking again. `redirect` sends a
   person whose role is not allowed to their home page instead of showing the
   "not for your account" card.

   `need` narrows an admin area further by Odoo group: "owner" (Owner or
   System, like Odoo's Owner Dashboard menu) or "system" (System only). */
export default function Gate({ allow, need, redirect = false, children }) {
  const outer = useContext(MeContext);
  if (outer?.me) return <InnerGate allow={allow} need={need} redirect={redirect} ctx={outer}>{children}</InnerGate>;
  return <RootGate allow={allow} need={need} redirect={redirect}>{children}</RootGate>;
}

/* The role is in `allow` and the flags meet `need`. */
export function admits(me, allow, need) {
  if (allow && !allow.includes(me?.role)) return false;
  const f = me?.flags || {};
  if (need === "owner") return !!(f.isOwner || f.isSystem);
  if (need === "system") return !!f.isSystem;
  return true;
}

function InnerGate({ allow, need, redirect, ctx, children }) {
  const router = useRouter();
  const ok = admits(ctx.me, allow, need);
  useEffect(() => { if (!ok && redirect) router.replace(roleHome(ctx.me.role)); }, [ok, redirect, ctx.me.role, router]);
  if (ok) return children;
  if (redirect) return <KraLoader fullScreen={false} />;
  return <Forbidden me={ctx.me} signOut={ctx.signOut} />;
}

function RootGate({ allow, need, redirect, children }) {
  const [phase, setPhase] = useState("checking"); /* checking | down | forbidden | ok */
  const [me, setMe] = useState(null);
  const [error, setError] = useState("");

  const toLogin = useCallback(() => {
    const here = location.pathname + location.search;
    location.replace("/login?next=" + encodeURIComponent(here));
  }, []);

  const load = useCallback(async () => {
    let r;
    try { r = await fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" }); }
    catch (e) { setPhase("down"); setError("Can't reach the server."); return; }
    if (r.status === 401) { toLogin(); return; }
    const data = await r.json().catch(() => null);
    if (!r.ok || !data?.ok) { setPhase("down"); setError(data?.error || "The server is not answering."); return; }
    setMe(data);
    const allowed = admits(data, allow, need);
    if (!allowed && redirect) { location.replace(roleHome(data.role)); return; }
    setPhase(allowed ? "ok" : "forbidden");
  }, [allow, need, redirect, toLogin]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onOut = () => toLogin();
    window.addEventListener("kpi:signedout", onOut);
    return () => window.removeEventListener("kpi:signedout", onOut);
  }, [toLogin]);

  const signOut = useCallback(async () => {
    try { await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }); } catch (e) {}
    location.href = "/login";
  }, []);

  if (phase === "ok") {
    return <MeContext.Provider value={{ me, refresh: load, signOut }}>{children}</MeContext.Provider>;
  }
  if (phase === "checking") return <KraLoader />;
  return (
    <div className="k-gate">
      {phase === "down" && <ServerDown message={error} onRetry={load} onSignOut={signOut} />}
      {phase === "forbidden" && <ForbiddenCard me={me} signOut={signOut} />}
    </div>
  );
}

function ForbiddenCard({ me, signOut }) {
  return (
    <div className="cardbox">
      <b style={{ fontSize: 17, color: "var(--navy)" }}>This area isn't for your account</b>
      <p className="note" style={{ margin: 0, color: "var(--subtle)" }}>You're signed in as {me?.name} ({me?.role}).</p>
      <div className="row"><a className="btn btn-primary" href={roleHome(me?.role)}>Go to my home</a><Button kind="ghost" onClick={signOut}>Sign out</Button></div>
    </div>
  );
}
function Forbidden({ me, signOut }) {
  return <div className="k-gate"><ForbiddenCard me={me} signOut={signOut} /></div>;
}
