import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { odooRpc, odooTarget, setupUidFrom } from "@/lib/odoo";
import { SETUP_NAME_COOKIE } from "@/lib/cookies";

export const dynamic = "force-dynamic";

/* The number field's dial code and local length, and the browser's setup:
   which server/database (to prefill the setup form) and who it is set up for.
   Set up → that person's country (from Login Management), as the phone does
   after device setup; not set up → setupName is empty and the page asks for
   setup first. */
export async function GET() {
  const jar = await cookies();
  const setupUid = setupUidFrom(jar);
  const { url, db } = await odooTarget();
  let setupName = "";
  try { setupName = setupUid ? decodeURIComponent(jar.get(SETUP_NAME_COOKIE)?.value || "") || "this account" : ""; } catch (e) { setupName = "this account"; }
  const base = { ok: true, setupName, serverUrl: url, db };
  if (!url || !setupUid) return NextResponse.json({ ...base, dial: "91", length: 10 });
  const r = await odooRpc("/kpi_app/config", { setup_uid: setupUid }, { fresh: true });
  if (!r.ok) return NextResponse.json({ ...base, dial: "91", length: 10, offline: true });
  return NextResponse.json({ ...base, dial: String(r.result?.dial || "91"), length: Number(r.result?.mobile_length || 10) });
}
