"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ErrorState, Icon, PageHeader, Skeleton, Tabs } from "@/components/ui";
import { useMe } from "@/lib/me";
import { useResource } from "@/lib/useFetch";
import { invalidate } from "@/lib/api";
import { NOTIF_PATH, markRead, eventMeta, notificationHref } from "@/lib/services/more";
import { sinceMs } from "@/lib/liveTime";
import { parseLocalTs } from "@/lib/services/kpiActions";

/* The feed, grouped Today / Yesterday / Earlier like the app. Clicking a row
   marks it read and opens what it is about. */
const TABS = [{ key: "all", label: "All" }, { key: "unread", label: "Unread" }, { key: "tasks", label: "Tasks" }, { key: "reports", label: "Reports & invoices" }];

export default function Notifications({ portal = false } = {}) {
  const { me } = useMe();
  const router = useRouter();
  const [tab, setTab] = useState("all");
  const feed = useResource(NOTIF_PATH, { limit: 100, offset: 0, only_unread: false }, { pollMs: 30000, ttl: 10000 });
  const items = feed.data?.items || [];
  const unread = feed.data?.unread_count || 0;

  const filtered = useMemo(() => items.filter((n) => tab === "all" || (tab === "unread" ? !n.is_read : tab === "tasks" ? !!n.kpi_id : (n.report_id || n.invoice_id || n.snapshot_id))), [items, tab]);
  const groups = useMemo(() => {
    const today = new Date().toDateString(), yd = new Date(Date.now() - 86400000).toDateString();
    const g = { Today: [], Yesterday: [], Earlier: [] };
    for (const n of filtered) {
      /* created_at is user-local wall-clock (convert_to_user_tz), not UTC. */
      const ms = parseLocalTs(n.created_at);
      const d = ms != null ? new Date(ms).toDateString() : "";
      (d === today ? g.Today : d === yd ? g.Yesterday : g.Earlier).push(n);
    }
    return Object.entries(g).filter(([, v]) => v.length);
  }, [filtered]);

  const open = async (n) => {
    if (!n.is_read) { markRead([n.id]).catch(() => {}); invalidate("/kpi_notifications"); }
    const to = notificationHref(n, me.role);
    if (to) router.push(to); else feed.refresh();
  };
  const all = async () => { await markRead([]); invalidate("/kpi_notifications"); feed.refresh(); };

  return (
    <>
      <PageHeader crumbs={[portal || me.role === "client" ? { label: "Portal", href: "/portal" } : { label: "Your work" }, { label: "Notifications" }]} title="Notifications">
        <Tabs items={TABS.map((t) => ({ ...t, count: t.key === "all" ? items.length : t.key === "unread" ? unread : undefined }))} value={tab} onChange={setTab} />
        <Button onClick={all} disabled={!unread}>Mark all read</Button>
      </PageHeader>
      <div className="page">
        {feed.error && !feed.data && <ErrorState error={feed.error} onRetry={feed.refresh} />}
        {!feed.data && !feed.error && <div className="cardbox"><Skeleton rows={5} /></div>}
        {feed.data && !groups.length && <div className="cardbox"><span className="mini">Nothing here{tab !== "all" ? " for this filter" : ""}.</span></div>}
        {groups.map(([label, rows]) => (
          <div key={label} className="cardbox">
            <h2>{label}</h2>
            {rows.map((n) => {
              const [icon, color] = eventMeta(n.event);
              const to = notificationHref(n, me.role);
              return (
                <div key={n.id} className={`notif ${n.is_read ? "" : "unread"}`} style={{ cursor: to ? "pointer" : "default" }} onClick={() => open(n)}>
                  <span className="icbox" style={{ background: color + "1F", color }}><Icon n={icon} size={18} /></span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p>{n.title || n.event}</p>
                    <small style={{ whiteSpace: "pre-line" }}>{(n.body || "").replace(/^[^\w\[]+/, "")}{n.kpi_name && !(n.body || "").includes(n.kpi_name) ? ` · ${n.kpi_name}` : ""}{n.client_name ? ` · ${n.client_name}` : ""} · {sinceMs(parseLocalTs(n.created_at))}</small>
                  </div>
                  {to && <Button size="sm" onClick={(e) => { e.stopPropagation(); open(n); }}>{n.invoice_id ? "Open invoice" : n.report_id ? "View report" : n.snapshot_id ? "Open" : "Open task"}</Button>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
