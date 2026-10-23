/* The one door between the browser and Odoo.

   /api/kpi/<anything>  ->  <ODOO_URL>/<anything>

   Everything the app reads or writes goes through here, so the browser only
   ever calls its own origin: no CORS, no preflight, and no way for a page
   script to learn where Odoo lives. The session cookie is httpOnly, so this is
   also the only place that can turn it into Odoo's `session_id`.

   Three request shapes, decided before the body is read:
   - GET                      → a type='http' download/view route (PDF, XLSX, ZIP,
                                image): streamed back untouched.
   - POST multipart/form-data → the file-upload routes: forwarded as-is; they
                                answer plain JSON, not the JSON-RPC envelope.
   - POST JSON                → a type='json' route: the body is the `params`,
                                the answer is the unwrapped `result`.

   Sign-in is the exception: /api/auth/* keeps its own handlers because those
   set and clear the cookie, which a generic proxy has no business doing. */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { odooRpc, odooRaw, sessionCookie, clearSessionCookie, clearRoleCookie, SESSION_COOKIE, OFFLINE } from "@/lib/odoo";

export const dynamic = "force-dynamic";

/* First path segments kra_kpi_module answers on (from a grep of its
   controllers), plus kpi_attendance from the optional attendance bridge module
   (kra_kpi_attendance_bridge; a server without it answers 404, which the
   Attendance page reads as "not installed"). Anything else is "Unknown request."
   Deliberately absent: kpi_pair (retired PIN-pairing shims the web never calls).
   kpi_cleanup (destructive maintenance) is NOT in this list: it goes through
   SYSTEM_ONLY below, which asks Odoo who the caller is before forwarding. */
const PREFIXES = new Set([
  "kra_kpi", "kpi", "kpi_action", "kpi_attendance", "kpi_billing", "kpi_meeting", "kpi_client_approval", "kpi_client_invoice",
  "kpi_client_portal", "kpi_client_workspace", "kpi_completion_cert", "kpi_config",
  "kpi_daily_report", "kpi_multitask", "kpi_notifications", "kpi_owner",
  "kpi_pending_queue", "kpi_pre_approval", "kpi_project", "kpi_reports", "kpi_requirements",
  "kpi_review", "kpi_task_approval", "kpi_user", "kpi_user_access", "kpi_wa_group",
  "kpi_wa_server", "kpi_workday", "kpi_workday_snapshot", "task_documents", "kpi_app",
]);
/* Odoo's own endpoints the app needs: ORM calls for kpi.reminder and
   app.user.manual (the mobile uses call_kw for those too). Nothing else under /web. */
const ODOO_OWN = new Set(["web/dataset/call_kw"]);
/* Cookie-setting routes go through /api/auth/*; public WhatsApp approval pages
   and FCM push registration are not the browser's business. */
/* /kpi/wa/<token> and /kpi/meet/<token> are public pages a CLIENT opens from a
   WhatsApp link; they must never be reached through a staff session. */
const BLOCKED = [/^kpi_app\/(login|login_check|otp|config)\b/, /^kpi\/wa\//, /^kpi\/meet(\/|$)/, /^kpi_push\//];

/* Destructive maintenance routes (Settings › Data cleanup). Forwarded only for
   a System administrator: the proxy checks /kpi_user/info for THIS session on
   every call, so a coordinator/owner/developer can't reach them by typing the
   URL. Odoo's own routes check again (System or Owner) — this is the narrower
   web rule on top. */
const SYSTEM_ONLY = new Set(["kpi_cleanup"]);

function badPath(parts) {
  if (!parts?.length || parts.length > 8) return true;
  if (parts.some((s) => !s || s === "." || s === "..")) return true;
  const joined = parts.join("/");
  if (BLOCKED.some((re) => re.test(joined))) return true;
  return !(PREFIXES.has(parts[0]) || SYSTEM_ONLY.has(parts[0]) || ODOO_OWN.has(joined));
}

async function isSystemAdmin(session) {
  if (!session) return false;
  const info = await odooRpc("/kpi_user/info", {}, { session });
  return !!(info.ok && info.result && info.result.status !== false && info.result.is_system);
}

async function handle(req, ctx) {
  const { path } = await ctx.params;
  if (badPath(path)) return NextResponse.json({ ok: false, error: "Unknown request." }, { status: 404 });

  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (SYSTEM_ONLY.has(path[0]) && !(await isSystemAdmin(session))) {
    return NextResponse.json({ status: false, message: "Only a System administrator can use data cleanup." }, { status: 403 });
  }
  const target = "/" + path.join("/") + new URL(req.url).search;
  const method = req.method;

  /* ---- downloads and views: stream bytes through ---- */
  if (method === "GET") {
    /* Range passes through so a video / voice note can be seeked in the
       View popup (Odoo answers 206 for it: kra_api.serve_file). */
    const range = req.headers.get("range");
    const r = await odooRaw(target, { session, headers: range ? { Range: range } : {} });
    if (!r) return NextResponse.json({ ok: false, error: OFFLINE }, { status: 503 });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location") || "";
      return NextResponse.json({ ok: false, error: /\/web\/login/.test(loc) ? "Please sign in again." : "Not available." },
        { status: /\/web\/login/.test(loc) ? 401 : 502 });
    }
    const type = r.headers.get("content-type") || "application/octet-stream";
    if (type.includes("json")) {
      /* Odoo answered about the file rather than with it (not yours / not there). */
      return NextResponse.json(await r.json().catch(() => ({ ok: false })), { status: r.status >= 400 ? r.status : 200 });
    }
    return new Response(r.body, {
      status: r.status,
      headers: {
        "Content-Type": type,
        "Content-Disposition": r.headers.get("content-disposition") || "inline",
        "Cache-Control": "no-store",
        ...Object.fromEntries(["content-length", "content-range", "accept-ranges"]
          .map((h) => [h, r.headers.get(h)]).filter(([, v]) => v)),
      },
    });
  }

  /* ---- multipart uploads: forward untouched, plain-JSON answer ----
     STREAMED, not buffered. Reading the whole body first (arrayBuffer) let the
     browser finish its hop to this proxy at once, so the upload bar jumped to
     100% and the real transfer to Odoo happened under "Saving…". Piped through,
     the browser can only send as fast as Odoo reads, and its progress events
     follow the actual upload. Content-Length is passed on so Odoo gets a
     fixed-length body, not a chunked one. */
  const contentType = req.headers.get("content-type") || "";
  if (contentType.startsWith("multipart/form-data")) {
    const len = req.headers.get("content-length");
    const r = await odooRaw(target, {
      method: "POST", session, body: req.body, timeout: 600000,
      headers: { "Content-Type": contentType, ...(len ? { "Content-Length": len } : {}) },
    });
    if (!r) return NextResponse.json({ ok: false, error: OFFLINE }, { status: 503 });
    if (r.status >= 300 && r.status < 400) return NextResponse.json({ ok: false, error: "Please sign in again." }, { status: 401 });
    const text = await r.text();
    const res = new NextResponse(text, { status: r.status >= 500 ? 502 : r.status, headers: { "Content-Type": r.headers.get("content-type") || "application/json", "Cache-Control": "no-store" } });
    return res;
  }

  /* ---- JSON-RPC ---- */
  const params = (await req.json().catch(() => null)) ?? {};
  /* The 369 AI Assistant may wait on up to three AI providers in turn (25 s
     each), so its questions get longer than the usual 60 s. */
  const slow = target.startsWith("/kra_kpi/ai_assistant/ask") || target.startsWith("/kra_kpi/ai_assistant/export");
  const r = await odooRpc(target, params, { session, ...(slow ? { timeout: 100000 } : {}) });
  const res = NextResponse.json(r.ok ? r.result ?? null : r.body, { status: r.ok ? 200 : r.status });
  /* Never let a shared cache hold an answer that was fetched as this person. */
  res.headers.set("Cache-Control", "no-store");
  /* Odoo's clock, so the browser can correct its own (every live timer is
     "now minus a timestamp the SERVER wrote"). */
  if (r.date) res.headers.set("x-odoo-date", r.date);

  if (!r.ok && r.status === 401 && session) {
    /* The cookie is dead. Drop it, or middleware.js keeps waving it through. */
    res.cookies.set(clearSessionCookie());
    res.cookies.set(clearRoleCookie());
  } else if (r.session && r.session !== session) {
    /* Odoo rotated the session id; follow it. */
    res.cookies.set(sessionCookie(r.session, { remember: true }));
  }
  return res;
}

export const GET = handle;
export const POST = handle;
