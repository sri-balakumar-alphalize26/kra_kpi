import { NextResponse } from "next/server";
import { SESSION_COOKIE, ROLE_COOKIE, roleHome } from "@/lib/cookies";

/* Pages that need an account. The cookie's presence gates the page; the page's
   own "who am I" call (/api/auth/me, in components/shell/Gate.jsx) validates it
   against Odoo once it loads and is the real authority on the role.

   Areas:
     /portal/**   clients (and admins who are also in the KRA Client group;
                  the Shell sends other admins home, as the cookie has no flags)
     everything else under the app: developers and admins; a client is sent to /portal
       of which ADMIN_ONLY: admins; a developer is sent to /your-work (the
       segment layouts' Gate makes the same check against /api/auth/me, and
       /dashboards also needs the Owner or System group there)
     /login/**    public
   "/" goes to the role's home. */
const PUBLIC = ["/login"];
const ADMIN_ONLY = ["/settings", "/people", "/queue", "/approvals", "/intake", "/dashboard", "/dashboards", "/reports"];
const under = (path, p) => path === p || path.startsWith(p + "/");

export function middleware(req) {
  const path = req.nextUrl.pathname;
  const session = req.cookies.get(SESSION_COOKIE)?.value;
  const role = req.cookies.get(ROLE_COOKIE)?.value || "";

  if (PUBLIC.some((p) => path === p || path.startsWith(p + "/"))) {
    /* Already signed in? Straight to the home page (unless ?next= says otherwise). */
    if (session && role && path === "/login" && !req.nextUrl.searchParams.get("next")) {
      return NextResponse.redirect(new URL(roleHome(role), req.url));
    }
    return NextResponse.next();
  }

  if (!session) return toSignIn(req);

  if (path === "/") return NextResponse.redirect(new URL(roleHome(role), req.url));

  const inPortal = path === "/portal" || path.startsWith("/portal/");
  if (inPortal && role === "developer") return NextResponse.redirect(new URL("/your-work", req.url));
  if (!inPortal && role === "client") return NextResponse.redirect(new URL("/portal", req.url));
  if (role === "developer" && ADMIN_ONLY.some((p) => under(path, p))) return NextResponse.redirect(new URL("/your-work", req.url));

  const res = NextResponse.next();
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
}

function toSignIn(req) {
  const target = "/login?next=" + encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search);
  /* Never req.nextUrl's own host: behind a reverse proxy that is the app's
     internal address. A proxy that says which address the visitor used gets a
     normal redirect to it; one that doesn't gets a page that moves the browser
     on by itself (a relative address, resolved where the visitor really is). */
  const host = req.headers.get("x-forwarded-host");
  if (host && !/^(localhost|127\.|\[?::1)/i.test(host.trim())) {
    const proto = (req.headers.get("x-forwarded-proto") || "https").split(",")[0].trim();
    return NextResponse.redirect(`${proto}://${host.split(",")[0].trim()}${target}`, 307);
  }
  if (/^(localhost|127\.)/i.test(req.nextUrl.hostname)) return NextResponse.redirect(new URL(target, req.url), 307);
  const href = target.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=${href}">` +
    `<script>location.replace(${JSON.stringify(target)})</script>` +
    `<a href="${href}">Sign in to continue</a>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

/* Every page path, but never the app's own files, images or API routes. */
export const config = { matcher: ["/((?!_next/|api/|web/|brand/|fonts/|favicon|icon|robots).*)"] };
