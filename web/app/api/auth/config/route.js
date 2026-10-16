import { NextResponse } from "next/server";
import { odooRpc } from "@/lib/odoo";

export const dynamic = "force-dynamic";

/* The company's dial code and local mobile length, for the number field. */
export async function GET() {
  const r = await odooRpc("/kpi_app/config", {}, { fresh: true });
  if (!r.ok) return NextResponse.json({ ok: true, dial: "91", length: 10, offline: true });
  return NextResponse.json({ ok: true, dial: String(r.result?.dial || "91"), length: Number(r.result?.mobile_length || 10) });
}
