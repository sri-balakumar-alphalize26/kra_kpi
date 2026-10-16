// Screenshot pages of the local dev server with the machine's Edge.
// usage: node scripts/shot.mjs [<out-dir>] <url> [<url> ...]     (out-dir defaults to screenshots/)
// env:   KPI_MOBILE + KPI_PASSWORD  → signs in first (mobile tab), so signed-in pages can be shot
//        KPI_THEME                  → data-theme to use (default krakpi)
//        KPI_WAIT                   → ms to wait before each shot, for animations (default 2500)
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const outDir = /^https?:/.test(args[0]) ? "screenshots" : args.shift();
const urls = args;
mkdirSync(outDir, { recursive: true });
const base = new URL(urls[0]).origin;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

if (process.env.KPI_MOBILE && process.env.KPI_PASSWORD) {
  await page.goto(`${base}/login?theme=${process.env.KPI_THEME || "krakpi"}`, { waitUntil: "networkidle", timeout: 120000 });
  await page.getByLabel("Mobile number").fill(process.env.KPI_MOBILE);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Password", { exact: true }).fill(process.env.KPI_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120000 });
  console.log("signed in →", page.url());
}

for (const url of urls) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
  await page.waitForTimeout(Number(process.env.KPI_WAIT || 2500));
  const name = new URL(url).pathname.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "root";
  await page.screenshot({ path: `${outDir}/${name}.png`, caret: "initial" });
  console.log("shot", name, page.url());
}
console.log("console errors:", errors.length ? errors : "none");
await browser.close();
