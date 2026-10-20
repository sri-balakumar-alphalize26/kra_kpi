import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { odooRpc, clientIp, setupUidFrom } from "@/lib/odoo";
import { finishSignIn, deviceName } from "@/lib/auth";

/* Mobile number + app password → the same /kpi_app/login the phone uses,
   with the browser's setup_uid so the server applies the same device lock
   (only the set-up person's number). The route is public, so a fresh
   db-bound session is started first and Odoo finalizes it as the user. */
export async function POST(req) {
  const { mobile, password, remember = true } = await req.json().catch(() => ({}));
  if (!mobile || !password) return NextResponse.json({ ok: false, error: "Enter your number and password.", field: !mobile ? "mobile" : "password" }, { status: 400 });
  const setup_uid = setupUidFrom(await cookies());
  const r = await odooRpc("/kpi_app/login", { mobile, password, device: deviceName(req), setup_uid },
    { fresh: true, forwardFor: clientIp(req), device: req.headers.get("user-agent") });
  if (!r.ok) return NextResponse.json(r.body, { status: r.status });
  if (!r.result?.status) {
    return NextResponse.json({ ok: false, error: r.result?.error || "Login failed.", field: "password" }, { status: 401 });
  }
  if (!r.session) return NextResponse.json({ ok: false, error: "Signed in, but the server gave no session. Check ODOO_DB." }, { status: 502 });
  return finishSignIn(r.session, { remember, extra: { mustChange: !!r.result.must_change } });
}
