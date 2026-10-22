"use client";
import { useEffect, useState } from "react";
import Icon from "./Icon";

/* Tap a task file → it opens in a popup instead of downloading (the web twin
   of Odoo's static/src/js/kpi_file_viewer.js). One capture-phase click
   handler covers every file link in the app (FileChips, the Files tab,
   manuals, documents): photos, videos (seekable: the proxy passes Range and
   Odoo answers 206), audio and PDFs are shown; anything else offers Download.
   Links marked as downloads (a `download` attribute, or titled / labelled
   "Download") keep downloading. Mounted once, in Shell. */
const BASE = "/api/kpi";
const ROUTES = [
  [/\/kpi\/progress\/download\?/, (u) => u.replace("/kpi/progress/download?", "/kpi/progress/view?")],
  [/\/kpi\/progress\/view\?/, (u) => u],
  [/\/kpi\/attachment\/download\?/, (u) => `${u}&inline=1`],
  [/\/kpi\/manual\/download\/\d+/, (u) => u.replace("/kpi/manual/download/", "/kpi/manual/view/")],
  [/\/kpi\/manual\/view\/\d+/, (u) => u],
  [/\/kpi_completion_cert\/download_doc\?/, (u) => `${u}&inline=1`],
];
const inlineUrl = (h) => { if (!h.includes(BASE)) return null; for (const [re, fn] of ROUTES) if (re.test(h)) return fn(h); return null; };
const downloadUrl = (u) => u.replace("/kpi/progress/view?", "/kpi/progress/download?").replace("/kpi/manual/view/", "/kpi/manual/download/").replace(/&inline=1/, "");

async function typeOf(url) {
  try {
    const r = await fetch(url, { headers: { Range: "bytes=0-0" }, credentials: "same-origin" });
    return (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  } catch { return ""; }
}

export function FileViewerHost() {
  const [file, setFile] = useState(null); /* {url, name, mime} */
  useEffect(() => {
    const onClick = (e) => {
      const a = e.target.closest?.("a[href]");
      if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const url = inlineUrl(a.getAttribute("href") || "");
      if (!url) return;
      const label = `${a.getAttribute("aria-label") || ""} ${a.getAttribute("title") || ""} ${a.textContent || ""}`;
      if (a.hasAttribute("download") || (/download/i.test(label) && !/view/i.test(label))) return;
      e.preventDefault(); e.stopPropagation();
      const name = (a.getAttribute("title") || a.textContent || "File").trim();
      setFile({ url, name, mime: null });
      typeOf(url).then((mime) => setFile((f) => (f && f.url === url ? { ...f, mime } : f)));
    };
    const onKey = (e) => { if (e.key === "Escape") setFile(null); };
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", onClick, true); document.removeEventListener("keydown", onKey); };
  }, []);
  if (!file) return null;
  const { url, name, mime } = file;
  const body = mime == null ? <span className="fv-none">Loading…</span>
    : mime.startsWith("image/") ? <img src={url} alt={name} />
    : mime.startsWith("video/") ? <video src={url} controls playsInline preload="metadata" />
    : mime.startsWith("audio/") ? <audio src={url} controls preload="metadata" />
    : mime === "application/pdf" || mime.startsWith("text/") ? <iframe src={url} title={name} />
    : <span className="fv-none">This file cannot be shown here.<br />Use <b>Download</b> to open it.</span>;
  return (
    <div className="fv" role="dialog" aria-modal="true" aria-label={name} onClick={(e) => { if (e.target === e.currentTarget) setFile(null); }}>
      <div className="fv-card">
        <div className="fv-hd">
          <b className="fv-name" title={name}>{name}</b>
          <a className="btn" href={downloadUrl(url)} download><Icon n="download" size={15} /> Download</a>
          <a className="btn" href={url} target="_blank" rel="noreferrer" title="Open in a new tab">Open</a>
          <button type="button" className="icon-btn" aria-label="Close" onClick={() => setFile(null)}><Icon n="x" size={18} /></button>
        </div>
        <div className="fv-bd">{body}</div>
      </div>
    </div>
  );
}
