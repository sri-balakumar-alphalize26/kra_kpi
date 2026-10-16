import { NextResponse } from "next/server";
import { odooRpc, clientIp } from "@/lib/odoo";
import { finishSignIn } from "@/lib/auth";

/* Odoo account (login + password) → /web/session/authenticate. For admins who
   live in Odoo and have no app mobile login. */
export async function POST(req) {
  const { login, password, remember = true } = await req.json().catch(() => ({}));
  if (!login || !password) return NextResponse.json({ ok: false, error: "Enter your login and password.", field: !login ? "login" : "password" }, { status: 400 });
  const db = (process.env.ODOO_DB || "").trim();
  const r = await odooRpc("/web/session/authenticate", { db: db || undefined, login, password },
    { fresh: true, forwardFor: clientIp(req) });
  if (!r.ok) {
    if (r.status === 403 || /access denied|wrong login/i.test(r.body?.error || "")) {
      return NextResponse.json({ ok: false, error: "Wrong login or password.", field: "password" }, { status: 401 });
    }
    return NextResponse.json(r.body, { status: r.status });
  }
  if (!r.result?.uid) return NextResponse.json({ ok: false, error: "Wrong login or password.", field: "password" }, { status: 401 });
  if (!r.session) return NextResponse.json({ ok: false, error: "Signed in, but the server gave no session. Check ODOO_DB." }, { status: 502 });
  return finishSignIn(r.session, { remember });
}
