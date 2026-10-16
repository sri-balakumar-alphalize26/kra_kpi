/* Shared by the /api/auth/* route handlers: finish a sign-in by asking Odoo who
   the session belongs to and setting the two cookies. */
import { NextResponse } from "next/server";
import { odooRpc, normalizeMe, sessionCookie, roleCookie, clearSessionCookie, clearRoleCookie } from "@/lib/odoo";

export async function finishSignIn(session, { remember = true, extra = {} } = {}) {
  const info = await odooRpc("/kpi_user/info", {}, { session });
  if (!info.ok) return NextResponse.json(info.body, { status: info.status });
  if (!info.result || info.result.status === false) {
    return NextResponse.json({ ok: false, error: info.result?.message || "Could not read your account." }, { status: 502 });
  }
  const me = normalizeMe(info.result);
  const res = NextResponse.json({ ...me, ...extra });
  res.cookies.set(sessionCookie(session, { remember }));
  res.cookies.set(roleCookie(me.role, { remember }));
  return res;
}

export function signedOut(body = { ok: false, error: "Please sign in again." }, status = 401) {
  const res = NextResponse.json(body, { status });
  res.cookies.set(clearSessionCookie());
  res.cookies.set(clearRoleCookie());
  return res;
}

/* A short description of the browser for Login Management's "last device". */
export function deviceName(req) {
  const ua = req.headers.get("user-agent") || "";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "web";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "browser";
  return `${br} on ${os} (web)`;
}
