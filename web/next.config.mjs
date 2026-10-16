import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/* Which code is running, fixed into the page when it is built, so after a
   deploy anyone can see whether the new build is live (profile menu footer).
   No git on the build machine (a zip deploy) just leaves the commit blank. */
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const stamp = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "2-digit" })
  .format(new Date()).replace(/\D/g, "");
const git = (args) => { try { return execSync(`git ${args}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /* The Expo app one level up has its own package-lock; this app is its own root. */
  outputFileTracingRoot: new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),

  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version ? `${pkg.version}.${stamp}` : "",
    NEXT_PUBLIC_APP_BUILD: git("rev-parse --short HEAD"),
    NEXT_PUBLIC_APP_BUILT: new Date().toISOString(),
  },

  /* A production build can live beside the dev server's `.next` without
     touching it: NEXT_DIST_DIR=.next-prod for both `next build` and `next start`. */
  distDir: process.env.NEXT_DIST_DIR || ".next",

  /* Avatars and attachments come back from Odoo as short addresses like
     /web/image/res.users/7/avatar_128, which the browser asks this app for.
     They are route handlers (app/web/image, app/web/content via
     odooPassthrough in lib/odoo.js), not rewrites, because a rewrite cannot
     attach ODOO_DB or the session cookie. */
};

export default nextConfig;
