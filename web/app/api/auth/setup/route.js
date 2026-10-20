import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { odooRpc, odooTarget, clientIp, normalizeServerUrl, setupCookies, clearSessionCookie, clearRoleCookie } from "@/lib/odoo";

/* Set up this browser — the phone's device setup: server URL → database (from
   /api/auth/databases) → Odoo login + password.

   The Odoo login proves who the browser belongs to. Nobody is signed in by it:
   the Odoo session is read for the uid and name, then destroyed. From then on
   this browser talks to that server and database, the number login shows that
   person's country code, and only their number may sign in here (the server's
   device lock, via setup_uid). Running it again moves the browser. */
export async function POST(req) {
  const { url, db, login, password } = await req.json().catch(() => ({}));
  const base = normalizeServerUrl(url);
  if (!base) return NextResponse.json({ ok: false, error: "Enter the server address.", field: "url" }, { status: 400 });
  if (!db) return NextResponse.json({ ok: false, error: "Choose a database.", field: "db" }, { status: 400 });
  if (!login || !password) return NextResponse.json({ ok: false, error: "Enter the Odoo login and password.", field: !login ? "login" : "password" }, { status: 400 });
  const target = { url: base, db: String(db) };

  const r = await odooRpc("/web/session/authenticate", { db: target.db, login, password },
    { fresh: true, forwardFor: clientIp(req), target });
  if (!r.ok) {
    if (r.status === 403 || /access denied|wrong login/i.test(r.body?.error || "")) {
      return NextResponse.json({ ok: false, error: "Wrong login or password.", field: "password" }, { status: 401 });
    }
    return NextResponse.json(r.body, { status: r.status });
  }
  if (!r.result?.uid || !r.session) return NextResponse.json({ ok: false, error: "Wrong login or password.", field: "password" }, { status: 401 });

  const info = await odooRpc("/kpi_user/info", {}, { session: r.session, target });
  await odooRpc("/web/session/destroy", {}, { session: r.session, target }).catch(() => {});
  if (!info.ok || info.result?.status === false) {
    return NextResponse.json({ ok: false, error: "Signed in, but this database doesn't have the KRA/KPI module." }, { status: 502 });
  }
  const uid = info.result?.user_id || r.result.uid;
  const name = info.result?.name || r.result.name || login;

  const res = NextResponse.json({ ok: true, name });
  for (const c of setupCookies({ url: base, db: target.db, uid, name })) res.cookies.set(c);
  /* Another server or database: whatever session this browser held belongs
     to the old one. */
  const was = await odooTarget();
  if (was.url !== base || was.db !== target.db) {
    res.cookies.set(clearSessionCookie());
    res.cookies.set(clearRoleCookie());
  }
  return res;
}
