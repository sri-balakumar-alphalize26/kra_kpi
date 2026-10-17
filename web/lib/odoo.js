/* Server-side only: the route handlers talk to Odoo through this. The browser
   never sees ODOO_URL or Odoo's session cookie.

   Which Odoo and which database come from .env.local and nothing else:
     ODOO_URL=http://localhost:8069
     ODOO_DB=my_db
   ODOO_DB travels as Odoo's X-Odoo-Database header, so one Odoo holding many
   databases can serve this app without a --db-filter.

   kra_kpi_module's routes are Odoo `type='json'` routes, i.e. JSON-RPC:
     request  { jsonrpc: "2.0", method: "call", id, params: {...} }
     response { jsonrpc, id, result: {...} }  or  { jsonrpc, id, error: { code, message, data: { name, message } } }
   HTTP status is 200 either way; a dead session is error code 100
   (odoo.http.SessionExpiredException), not a redirect. `odooRpc` does the
   wrapping and unwrapping; `classifyError` turns an Odoo error into the HTTP
   status the browser-side lib/api.js reads. */

import { SESSION_COOKIE, ROLE_COOKIE } from "./cookies";
export { SESSION_COOKIE, ROLE_COOKIE };

const ODOO_URL = (process.env.ODOO_URL || "").trim().replace(/\/$/, "");
const ODOO_DB = (process.env.ODOO_DB || "").trim();

export const NOT_CONNECTED = "Server not connected. Set ODOO_URL in web/.env.local and restart.";
export const OFFLINE = "Can't reach the server. Try again in a moment.";
if (!ODOO_URL) console.error(`[kra-kpi-web] ${NOT_CONNECTED}`);

function odooHeaders(base, session, forwardFor, device) {
  const headers = { ...base };
  if (ODOO_DB) headers["X-Odoo-Database"] = ODOO_DB;
  if (session) headers.Cookie = `session_id=${session}`;
  /* The browser's address, so Odoo's per-number lock-outs (5 wrong passwords)
     see each visitor rather than this one server. */
  if (forwardFor) headers["X-Forwarded-For"] = forwardFor;
  if (device) headers["X-Kpi-Device"] = String(device).slice(0, 300);
  return headers;
}

/* The visitor's address as the request reached us. */
export function clientIp(req) {
  const fwd = req.headers.get("x-forwarded-for") || "";
  return fwd.split(",")[0].trim() || req.headers.get("x-real-ip") || "";
}

/* A brand-new Odoo session already tied to ODOO_DB. Sign-in needs one: a
   header-only request is stateless in Odoo, so the session /kpi_app/login
   finalizes would never be saved. /web/login?db= is Odoo's own way to pick a
   database. Returns null when Odoo is unreachable or hands out no cookie. */
async function freshSession() {
  try {
    const r = await fetch(`${ODOO_URL}/web/login${ODOO_DB ? `?db=${encodeURIComponent(ODOO_DB)}` : ""}`, {
      cache: "no-store", redirect: "manual",
    });
    const m = (r.headers.get("set-cookie") || "").match(/session_id=([^;]+)/);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

/* One JSON-RPC call. Resolves to
     { ok: true,  result, session, date }
     { ok: false, status, body, session, date }   -- already classified for the browser
   `fresh`: start from a session bound to ODOO_DB (sign-in). `timeout` in ms. */
export async function odooRpc(path, params = {}, { session, fresh, forwardFor, device, timeout = 60000 } = {}) {
  if (!ODOO_URL) return { ok: false, status: 503, body: { ok: false, error: NOT_CONNECTED }, session: null };
  let started = null;
  if (fresh && !session) started = await freshSession();
  const sent = session || started;
  const headers = odooHeaders({ "Content-Type": "application/json", Accept: "application/json" }, sent, forwardFor, device);
  let r;
  try {
    r = await fetch(ODOO_URL + path, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: Date.now(), params }),
      cache: "no-store", redirect: "manual",
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    return { ok: false, status: 503, body: { ok: false, error: OFFLINE }, session: null };
  }
  const m = (r.headers.get("set-cookie") || "").match(/session_id=([^;]+)/);
  const newSession = m ? m[1] : (started || null);
  const date = r.headers.get("date") || "";

  if (r.status >= 300 && r.status < 400) {
    /* A JSON route never redirects; an http one does when the session is gone. */
    const location = r.headers.get("location") || "";
    return /\/web\/login/.test(location)
      ? { ok: false, status: 401, body: { ok: false, error: "Please sign in again." }, session: newSession, date }
      : { ok: false, status: 502, body: { ok: false, error: "The server is not configured for this app." }, session: newSession, date };
  }
  if (r.status === 403 && sent) {
    /* The cookie belongs to another database than ODOO_DB. */
    return { ok: false, status: 401, body: { ok: false, error: "Please sign in again." }, session: newSession, date };
  }
  if (r.status >= 500) return { ok: false, status: 502, body: { ok: false, error: OFFLINE }, session: newSession, date };

  let data = null;
  try { data = await r.json(); } catch (e) {}
  if (!data) return { ok: false, status: 502, body: { ok: false, error: "Unexpected answer from the server." }, session: newSession, date };
  if (data.error) return { ok: false, ...classifyError(data.error), session: newSession, date };
  return { ok: true, result: data.result, session: newSession, date };
}

/* Odoo's JSON-RPC error → the HTTP status + body lib/api.js understands.
   The message is kept: a UserError's text is what the person should read. */
export function classifyError(error) {
  const name = error?.data?.name || "";
  const message = error?.data?.message || error?.message || "Request failed.";
  if (error?.code === 100 || /SessionExpired/i.test(name)) return { status: 401, body: { ok: false, error: "Please sign in again." } };
  if (/AccessDenied|AccessError/i.test(name)) return { status: 403, body: { ok: false, error: message } };
  if (/UserError|ValidationError/i.test(name)) return { status: 400, body: { ok: false, error: message } };
  if (/MissingError/i.test(name)) return { status: 404, body: { ok: false, error: message } };
  return { status: 502, body: { ok: false, error: message } };
}

/* The cookie the browser holds. httpOnly, so page scripts cannot read it. */
export function sessionCookie(value, { remember } = {}) {
  return {
    name: SESSION_COOKIE, value,
    httpOnly: true, sameSite: "lax", path: "/",
    secure: process.env.NODE_ENV === "production",
    ...(remember ? { maxAge: 60 * 60 * 24 * 30 } : {}),
  };
}
export function clearSessionCookie() { return { ...sessionCookie(""), maxAge: 0 }; }

/* The role hint middleware.js reads to send people to their own area. Also
   httpOnly: nothing in the page needs it (the page asks /api/auth/me). */
export function roleCookie(role, { remember } = {}) {
  return {
    name: ROLE_COOKIE, value: role || "",
    httpOnly: true, sameSite: "lax", path: "/",
    secure: process.env.NODE_ENV === "production",
    ...(remember ? { maxAge: 60 * 60 * 24 * 30 } : {}),
  };
}
export function clearRoleCookie() { return { ...roleCookie(""), maxAge: 0 }; }

/* Same headers as odooRpc, but the raw Response: PDFs, images, ZIPs and the
   multipart uploads, which must not be parsed as JSON. */
export async function odooRaw(path, { method = "GET", session, headers: extra = {}, body, timeout = 120000 } = {}) {
  if (!ODOO_URL) return null; /* caller answers 503 */
  try {
    return await fetch(ODOO_URL + path, {
      method, headers: odooHeaders({ Accept: "*/*", ...extra }, session), body,
      /* A streamed body (an upload passed straight through) needs duplex:'half'
         in Node's fetch; a buffer or no body must not carry it. */
      ...(body && typeof body.getReader === "function" ? { duplex: "half" } : {}),
      cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    return null;
  }
}

/* Pictures: /web/image/res.users/7/avatar_128 and /web/content/<attachment>.
   Passed through WITH the session (an avatar or an attachment is not public). */
const PASSED = ["content-type", "content-length", "content-disposition", "cache-control", "etag", "last-modified"];

export async function odooPassthrough(req, path, session) {
  if (!ODOO_URL) return new Response(NOT_CONNECTED, { status: 503 });
  const headers = odooHeaders({ Accept: req.headers.get("accept") || "*/*" }, session);
  for (const h of ["if-none-match", "if-modified-since"]) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }
  let r;
  try {
    r = await fetch(ODOO_URL + path + new URL(req.url).search, { headers, cache: "no-store", redirect: "manual" });
  } catch (e) {
    return new Response(null, { status: 503 });
  }
  if (r.status >= 300 && r.status < 400) return new Response(null, { status: 401 });
  const out = new Headers();
  for (const h of PASSED) {
    const v = r.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(r.status === 304 ? null : r.body, { status: r.status, headers: out });
}

/* The signed-in person as the app sees them, from /kpi_user/info. The role is
   kpi_role when the server gives it (it always does on 19.0.5.x); the flag
   fallback mirrors the mobile app (App.js). */
export function normalizeMe(info) {
  const role = info.kpi_role
    || ((info.is_system || info.is_owner || info.is_admin) ? "admin" : info.is_client_only ? "client" : "developer");
  return {
    ok: true,
    uid: info.user_id, name: info.name || "", login: info.login || "",
    role,
    flags: {
      isSystem: !!info.is_system, isOwner: !!info.is_owner, isAdmin: !!info.is_admin,
      isDeveloper: !!info.is_developer, isClient: !!info.is_client, allowMultitask: !!info.allow_multitask,
    },
    mustChange: !!info.must_change,
  };
}
