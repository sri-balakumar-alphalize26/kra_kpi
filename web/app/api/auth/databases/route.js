import { NextResponse } from "next/server";
import { normalizeServerUrl } from "@/lib/odoo";

/* Setup step 1: the databases on the server at `url` — the phone's Connect
   screen (POST /web/database/list, then GET). Asked by this web server, so
   the browser needs no access to Odoo of its own. */
export async function POST(req) {
  const { url } = await req.json().catch(() => ({}));
  const base = normalizeServerUrl(url);
  if (!base) return NextResponse.json({ ok: false, error: "Enter the server address, e.g. http://192.168.1.5:8069" }, { status: 400 });
  const pick = (d) => (Array.isArray(d) ? d : Array.isArray(d?.result) ? d.result : Array.isArray(d?.result?.databases) ? d.result.databases : null);
  let refused = false;
  try {
    const r = await fetch(`${base}/web/database/list`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: {} }),
      cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(15000),
    });
    const data = await r.json().catch(() => null);
    if (data?.error) refused = true;
    const dbs = pick(data);
    if (dbs?.length) return NextResponse.json({ ok: true, url: base, databases: dbs });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "Can't reach that server. Check the address and that Odoo is running." }, { status: 502 });
  }
  try {
    const r = await fetch(`${base}/web/database/list`, { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(15000) });
    const dbs = pick(await r.json().catch(() => null));
    if (dbs?.length) return NextResponse.json({ ok: true, url: base, databases: dbs });
  } catch (e) {}
  return NextResponse.json({ ok: false, error: refused
    ? "That server hides its database list (list_db = False in odoo.conf). Turn it on and try again."
    : "No databases found on that server." }, { status: 404 });
}
