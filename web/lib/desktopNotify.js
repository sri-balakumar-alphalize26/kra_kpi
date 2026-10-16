"use client";
/* Desktop (system) notifications while a KRA KPI tab is open, even in the
   background. Polls the unread feed and raises a browser Notification for
   anything newer than the last id this browser has seen. The last-seen id is
   kept per user in localStorage, so other open tabs and reloads don't repeat
   it, and the tag stops two tabs showing the same one twice. */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { invalidate } from "@/lib/api";
import { getPref, setPref } from "@/lib/prefs";
import { fetchNotifications, markRead, notificationHref } from "@/lib/services/more";

const POLL_MS = 30000;
const MAX_AT_ONCE = 3;

export function desktopSupported() {
  return typeof window !== "undefined" && "Notification" in window && window.isSecureContext;
}

/* "granted" | "denied" | "default" | "unsupported" */
export function desktopPermission() {
  return desktopSupported() ? Notification.permission : "unsupported";
}

/* On unless the user switched it off in the account menu. */
export const desktopEnabled = (uid) => getPref("desktopNotify", uid, true) !== false;
export const setDesktopEnabled = (uid, on) => setPref("desktopNotify", uid, on ? null : false);

export async function askDesktopPermission() {
  if (!desktopSupported()) return "unsupported";
  try { return await Notification.requestPermission(); } catch (_) { return Notification.permission; }
}

/* Permission + on/off for the top bar and the account menu. Both re-read on
   "kpi:desktop" (fired after any change here) and on window focus, since the
   permission can be changed from the browser's site settings. */
export function useDesktopState(uid) {
  const [st, setSt] = useState({ perm: "unsupported", on: true });
  const sync = useCallback(() => setSt({ perm: desktopPermission(), on: desktopEnabled(uid) }), [uid]);
  useEffect(() => {
    sync();
    window.addEventListener("kpi:desktop", sync);
    window.addEventListener("focus", sync);
    return () => { window.removeEventListener("kpi:desktop", sync); window.removeEventListener("focus", sync); };
  }, [sync]);
  const changed = () => window.dispatchEvent(new Event("kpi:desktop"));
  const turnOn = async () => {
    const p = desktopPermission() === "default" ? await askDesktopPermission() : desktopPermission();
    if (p === "granted") setDesktopEnabled(uid, true);
    changed();
    return p;
  };
  const turnOff = () => { setDesktopEnabled(uid, false); changed(); };
  return { ...st, active: st.perm === "granted" && st.on, turnOn, turnOff };
}

export function useDesktopNotifications(me) {
  const router = useRouter();
  useEffect(() => {
    if (!me?.uid || !desktopSupported()) return;
    let stopped = false;
    const inbox = me.role === "client" ? "/portal/notifications" : "/notifications";

    const show = (n) => {
      const note = new Notification(n.title || "KRA KPI", {
        body: [(n.body || "").replace(/^[^\w\[]+/, ""), n.kpi_name && !(n.body || "").includes(n.kpi_name) ? n.kpi_name : ""].filter(Boolean).join(" · "),
        icon: "/brand/icon-192.png",
        tag: `kpi-notif-${n.id}`,
      });
      note.onclick = () => {
        window.focus();
        note.close();
        markRead([n.id]).catch(() => {});
        invalidate("/kpi_notifications");
        router.push(notificationHref(n, me.role) || inbox);
      };
    };

    const tick = async () => {
      if (Notification.permission !== "granted" || !desktopEnabled(me.uid)) return;
      let items;
      try { ({ items } = await fetchNotifications({ limit: 10, onlyUnread: true, fresh: true })); } catch (_) { return; }
      if (stopped) return;
      const top = items.reduce((m, n) => Math.max(m, n.id || 0), 0);
      const seen = getPref("notifSeen", me.uid, null);
      /* First run in this browser: start from now instead of replaying old unread ones. */
      if (seen == null) { setPref("notifSeen", me.uid, top); return; }
      const fresh = items.filter((n) => n.id > seen).sort((a, b) => a.id - b.id);
      if (!fresh.length) return;
      setPref("notifSeen", me.uid, Math.max(seen, top));
      invalidate("/kpi_notifications");
      fresh.slice(-MAX_AT_ONCE).forEach(show);
    };

    tick();
    /* Not paused when the tab is hidden: that is the point. Browsers slow
       background timers to about once a minute, which is fine here. */
    const timer = setInterval(tick, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [me?.uid, me?.role, router]);
}
