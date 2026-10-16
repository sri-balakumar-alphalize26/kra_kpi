"use client";
/* Logo loading screen: the app icon pops in and floats with a glossy sweep,
   and the message types itself out with a blinking caret, naming the page
   being opened.
     <KraLoader />                        page name from the URL
     <KraLoader path="/notifications" />  name a route yourself
     <KraLoader fullScreen={false} />     just the card, inside the page area
   Styles are in loader.css and follow the theme tokens. */
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { TOP_NAV, WORK_SIDE, PORTAL_TABS } from "@/lib/nav";

/* Route -> title for "Opening <title>…", from the menus plus a few pages that
   are not menu items. The first label for a route wins. */
const EXTRA = { "/reports": "Reports", "/settings": "Settings", "/intake": "Intake", "/browse": "Browse", "/profile": "Profile", "/portal/profile": "Profile", "/portal/notifications": "Notifications" };
export const TITLES = [...TOP_NAV, ...WORK_SIDE, ...PORTAL_TABS].reduce((m, it) => {
  if (it.href && !m[it.href]) m[it.href] = it.label;
  return m;
}, { ...EXTRA });

export function loaderMessages(path = "") {
  const prefix = Object.keys(TITLES).sort((a, b) => b.length - a.length).find((p) => path.startsWith(p + "/"));
  const name = TITLES[path] || (prefix && TITLES[prefix]);
  return [name ? `Opening ${name}…` : "Signing you in…", "Loading your KRAs…", "Calculating your scores…", "Almost there…"];
}

/* Types each message out, holds it, fades, then the next one. */
function useTyped(msgs) {
  const [i, setI] = useState(0);
  const [n, setN] = useState(0);
  const [fade, setFade] = useState(false);
  const msg = msgs[i % msgs.length];
  useEffect(() => {
    if (n < msg.length) { const t = setTimeout(() => setN((x) => x + 1), 38); return () => clearTimeout(t); }
    const hold = setTimeout(() => setFade(true), 1100);
    const next = setTimeout(() => { setFade(false); setN(0); setI((x) => x + 1); }, 1450);
    return () => { clearTimeout(hold); clearTimeout(next); };
  }, [n, msg]);
  return { text: msg.slice(0, n), full: msg, fade };
}

export default function KraLoader({ path, fullScreen = true }) {
  const pathname = usePathname();
  const msgs = loaderMessages(path ?? pathname ?? "");
  const { text, full, fade } = useTyped(msgs);
  const card = (
    <div className="kl-card" role="status" aria-live="polite" aria-label={full}>
      <span className="kl-logo" aria-hidden="true"><img src="/brand/icon-512.png" alt="" width="128" height="128" /><i className="kl-shine" /></span>
      <div className="kl-msg" style={{ opacity: fade ? 0 : 1 }} aria-hidden="true">{text}<span className="kl-caret" /></div>
    </div>
  );
  return fullScreen ? <div className="kl-screen">{card}</div> : <div className="kl-inline">{card}</div>;
}
