import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { odooRpc, clientIp, setupUidFrom } from "@/lib/odoo";

/* A number's state before the password step: ready | needs_setup | unknown |
   disabled | wrong_device (the mobile's AppLoginScreen states). wrong_device:
   this browser is set up for someone else, and `name` says who. */
export async function POST(req) {
  const { mobile } = await req.json().catch(() => ({}));
  const setup_uid = setupUidFrom(await cookies());
  const r = await odooRpc("/kpi_app/login_check", { mobile: mobile || "", setup_uid }, { fresh: true, forwardFor: clientIp(req) });
  if (!r.ok) return NextResponse.json(r.body, { status: r.status });
  return NextResponse.json({ ok: true, state: r.result?.state || "unknown", name: r.result?.name || "" });
}
