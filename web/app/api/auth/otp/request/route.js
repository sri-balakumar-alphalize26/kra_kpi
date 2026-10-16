import { NextResponse } from "next/server";
import { odooRpc, clientIp } from "@/lib/odoo";

/* WhatsApp code for a password reset / first set-up. The answer is generic on
   purpose (the server does not say whether the number exists). */
export async function POST(req) {
  const { mobile } = await req.json().catch(() => ({}));
  const r = await odooRpc("/kpi_app/otp/request", { mobile: mobile || "" }, { fresh: true, forwardFor: clientIp(req) });
  if (!r.ok) return NextResponse.json(r.body, { status: r.status });
  return NextResponse.json({ ok: !!r.result?.status, sent: !!r.result?.sent, error: r.result?.error });
}
