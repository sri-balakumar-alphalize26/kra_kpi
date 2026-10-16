import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { odooRpc, normalizeMe, roleCookie, SESSION_COOKIE } from "@/lib/odoo";
import { signedOut } from "@/lib/auth";

export const dynamic = "force-dynamic";

/* Who am I. 401 clears the cookies (dead session); 503 keeps them (Odoo is
   just not answering right now). Refreshes the role hint, since Login
   Management may have changed the role since sign-in. */
export async function GET() {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!session) return signedOut();
  const r = await odooRpc("/kpi_user/info", {}, { session });
  if (!r.ok) return r.status === 401 ? signedOut() : NextResponse.json(r.body, { status: r.status });
  if (!r.result || r.result.status === false) {
    return NextResponse.json({ ok: false, error: r.result?.message || "Could not read your account." }, { status: 502 });
  }
  const me = normalizeMe(r.result);
  const res = NextResponse.json(me);
  res.cookies.set(roleCookie(me.role, { remember: true }));
  res.headers.set("Cache-Control", "no-store");
  return res;
}
