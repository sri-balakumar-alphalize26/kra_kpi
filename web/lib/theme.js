"use client";
import { useEffect, useState } from "react";

/* Two independent choices, both on <html> before the first paint (PRE_PAINT):
     data-theme = the SKIN   (krakpi | jira | family369 | dense)   colours + shape
     data-mode  = the MODE   (light | dark)                         resolved from
                  the stored mode (light | dark | system) + prefers-color-scheme
   Dark mode is one dark palette (app/themes/tokens.css [data-mode="dark"])
   that overrides whichever skin is active. */
export const SKINS = [
  { key: "krakpi", label: "KRA KPI blue", swatch: ["#1E40AF", "#F7F9FC", "#16306B"] },
  { key: "jira", label: "Jira classic", swatch: ["#0052CC", "#FFFFFF", "#172B4D"] },
  { key: "family369", label: "369 family", swatch: ["#0a78ab", "#0b3c58", "#f7931e"] },
  { key: "dense", label: "Dense warm", swatch: ["#0F766E", "#F6F4F0", "#262320"] },
];
export const THEMES = SKINS; /* older imports */
export const MODES = [{ key: "light", label: "Light" }, { key: "dark", label: "Dark" }, { key: "system", label: "System" }];
const SKIN_KEYS = new Set(SKINS.map((t) => t.key));
export const SKIN_KEY = "kpi.theme";
export const MODE_KEY = "kpi.mode";
const DEFAULT_SKIN = SKIN_KEYS.has(process.env.NEXT_PUBLIC_DEFAULT_THEME) ? process.env.NEXT_PUBLIC_DEFAULT_THEME : "krakpi";
const DEFAULT_MODE = "light";

/* Inline, runs before CSS paints. ?theme= and ?mode= override and are remembered. */
export const PRE_PAINT = `(function(){var d=document.documentElement;try{
var sk=${JSON.stringify([...SKIN_KEYS])},q=new URLSearchParams(location.search),qs=q.get("theme"),qm=q.get("mode");
var s=(sk.indexOf(qs)>-1?qs:null)||localStorage.getItem(${JSON.stringify(SKIN_KEY)})||${JSON.stringify(DEFAULT_SKIN)};if(sk.indexOf(s)<0)s=${JSON.stringify(DEFAULT_SKIN)};
var ms=["light","dark","system"],m=(ms.indexOf(qm)>-1?qm:null)||localStorage.getItem(${JSON.stringify(MODE_KEY)})||${JSON.stringify(DEFAULT_MODE)};if(ms.indexOf(m)<0)m=${JSON.stringify(DEFAULT_MODE)};
var r=m==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):m;
d.setAttribute("data-theme",s);d.setAttribute("data-mode",r);
if(sk.indexOf(qs)>-1)localStorage.setItem(${JSON.stringify(SKIN_KEY)},qs);if(ms.indexOf(qm)>-1)localStorage.setItem(${JSON.stringify(MODE_KEY)},qm);
}catch(e){d.setAttribute("data-theme",${JSON.stringify(DEFAULT_SKIN)});d.setAttribute("data-mode","light")}})();`;

const get = (k, fb) => { try { return localStorage.getItem(k) || fb; } catch (_) { return fb; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
const systemDark = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
export const resolveMode = (m) => (m === "system" ? (systemDark() ? "dark" : "light") : m === "dark" ? "dark" : "light");

/* ---- the switch animation ----------------------------------------------
   A circular reveal of the new look, spreading from where the click happened
   (View Transitions API). Browsers without it, and people who asked for
   reduced motion, get a short colour cross-fade instead. */
const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
function originOf(ev) {
  if (ev && typeof ev.clientX === "number" && (ev.clientX || ev.clientY)) return { x: ev.clientX, y: ev.clientY };
  const el = ev?.currentTarget || ev?.target;
  if (el && el.getBoundingClientRect) { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  return { x: window.innerWidth - 60, y: 28 };
}
function withTransition(apply, ev) {
  const d = document.documentElement;
  if (reduced() || !document.startViewTransition) {
    d.classList.add("theme-fading");
    apply();
    setTimeout(() => d.classList.remove("theme-fading"), 450);
    return;
  }
  const { x, y } = originOf(ev);
  const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  d.style.setProperty("--vt-x", `${x}px`); d.style.setProperty("--vt-y", `${y}px`); d.style.setProperty("--vt-r", `${r}px`);
  d.classList.add("theme-switching");
  const t = document.startViewTransition(() => apply());
  t.finished.finally(() => d.classList.remove("theme-switching"));
}

export function readSkin() { const v = typeof document !== "undefined" ? document.documentElement.getAttribute("data-theme") : null; return SKIN_KEYS.has(v) ? v : DEFAULT_SKIN; }
export function readMode() { const v = get(MODE_KEY, DEFAULT_MODE); return ["light", "dark", "system"].includes(v) ? v : DEFAULT_MODE; }
export function writeSkin(v, ev) {
  if (!SKIN_KEYS.has(v) || v === readSkin()) return;
  set(SKIN_KEY, v);
  withTransition(() => document.documentElement.setAttribute("data-theme", v), ev);
}
export function writeMode(m, ev) {
  if (!["light", "dark", "system"].includes(m)) return;
  set(MODE_KEY, m);
  const next = resolveMode(m);
  const apply = () => { document.documentElement.setAttribute("data-mode", next); window.dispatchEvent(new CustomEvent("kpi:mode", { detail: m })); };
  if (document.documentElement.getAttribute("data-mode") === next) { apply(); return; } /* system == current: nothing to animate */
  withTransition(apply, ev);
}

/* Hook: { skin, setSkin, mode, setMode, resolved, toggle } — `toggle` flips
   light ↔ dark (from "system" it flips to the opposite of what is showing). */
export function useTheme() {
  const [skin, setSkinState] = useState(DEFAULT_SKIN);
  const [mode, setModeState] = useState(DEFAULT_MODE);
  const [resolved, setResolved] = useState("light");
  useEffect(() => {
    setSkinState(readSkin()); const m = readMode(); setModeState(m); setResolved(resolveMode(m));
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onSys = () => { if (readMode() === "system") { const r = resolveMode("system"); document.documentElement.setAttribute("data-mode", r); setResolved(r); } };
    const onMode = (e) => { setModeState(e.detail); setResolved(resolveMode(e.detail)); };
    mq.addEventListener("change", onSys); window.addEventListener("kpi:mode", onMode);
    return () => { mq.removeEventListener("change", onSys); window.removeEventListener("kpi:mode", onMode); };
  }, []);
  const setSkin = (v, ev) => { writeSkin(v, ev); setSkinState(v); };
  const setMode = (m, ev) => { writeMode(m, ev); };
  const toggle = (ev) => setMode(resolved === "dark" ? "light" : "dark", ev);
  return { skin, setSkin, mode, setMode, resolved, toggle, isDark: resolved === "dark" };
}
