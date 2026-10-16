import { NextResponse } from "next/server";
import { odooRpc, clientIp } from "@/lib/odoo";

/* A number's state before the password step: ready | needs_setup | unknown |
   disabled (the mobile's AppLoginScreen states; `wrong_device` cannot happen
   here because no setup_uid is sent). */
export async function POST(req) {
  const { mobile } = await req.json().catch(() => ({}));
  const r = await odooRpc("/kpi_app/login_check", { mobile: mobile || "" }, { fresh: true, forwardFor: clientIp(req) });
  if (!r.ok) return NextResponse.json(r.body, { status: r.status });
  return NextResponse.json({ ok: true, state: r.result?.state || "unknown", name: r.result?.name || "" });
}
