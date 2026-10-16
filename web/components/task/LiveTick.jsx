"use client";
import { useNow } from "@/lib/liveTime";

/* One live clock reading (Odoo kpi_action.js LiveTick). It re-renders ONLY
   itself each tick; the board around it does not. The board used to read a
   shared one-second `now`, which re-rendered every card (500+ on an admin
   board) just to move a few timers.
     <LiveTick fn={(now) => fmtClock(secsSince(start, now))} />
   `fn` gets the server-corrected now and returns what to show. */
export default function LiveTick({ fn, active = true, every = 1000 }) {
  const now = useNow(active, every);
  return fn(now);
}
