"use client";
/* A small grey "Copy link" button next to a saved link (GitHub, Drive, any
   related link), as on the Odoo board (kpi_action.js copyLink). One click puts
   the URL on the clipboard without opening the link or the card around it. */
import Icon from "./Icon";
import { useFlags } from "./index";

/* navigator.clipboard needs a secure context, so the web opened on a plain-http
   LAN address (http://10.x.x.x:3100) has none; the hidden-textarea copy is the
   fallback there. */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch (_) { /* fall through to the textarea copy */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.readOnly = true;
    ta.style.position = "fixed"; ta.style.opacity = "0"; ta.style.top = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (_) { return false; }
}

export default function CopyLink({ url, size = 14 }) {
  const flags = useFlags();
  if (!url) return null;
  return (
    <button type="button" className="icon-btn" title="Copy link" aria-label="Copy link" style={{ flex: "none", color: "var(--subtle)" }}
      onClick={async (e) => {
        e.preventDefault(); e.stopPropagation();
        if (await copyText(url)) flags.ok("📋 Link copied");
        else flags.err("Could not copy — select the link and press Ctrl+C.");
      }}>
      <Icon n="copy" size={size} />
    </button>
  );
}
