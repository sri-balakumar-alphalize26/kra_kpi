"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ErrorState, Icon, PageHeader, Skeleton } from "@/components/ui";
import { useMe } from "@/lib/me";
import { useResource } from "@/lib/useFetch";
import * as K from "@/lib/services/kpiActions";
import { fetchKraTree } from "@/lib/services/settings";

/* Projects = clients (root KRAs), with task counts from the board. */
export default function Projects() {
  const { me } = useMe();
  const [tree, setTree] = useState(null); const [err, setErr] = useState("");
  const board = useResource(K.TASKS_PATH, { my_tasks_only: false }, { ttl: 15000 });
  useEffect(() => { fetchKraTree().then(setTree).catch((e) => setErr(e.message)); }, []);
  const tasks = board.data?.tasks || [];
  const cards = useMemo(() => (tree || []).map((n) => {
    /* A task's client_name is its NEAREST is_client KRA (client_kra_id), which
       can sit below the root, so match by every is_client node in this subtree
       (plus the root) and by the task ids the tree itself lists. */
    const ids = new Set(), names = new Set([n.name]);
    const walk = (node) => { if (node.is_client) names.add(node.name); for (const k of node.kpi_ids || []) ids.add(k.id); (node.child_ids || []).forEach(walk); };
    walk(n);
    const mine = tasks.filter((t) => ids.has(t.id) || names.has(t.client_name));
    const lanes = K.groupIntoLanes(mine);
    const count = (node) => (node.kpi_ids || []).length + (node.child_ids || []).reduce((s, c) => s + count(c), 0);
    return { n, open: mine.filter((t) => t.task_state !== "completed").length, running: lanes.in_progress.length, review: lanes.approvals.length + lanes.awaiting_client.length, done: lanes.completed.length, total: count(n), projects: (n.child_ids || []).length };
  }), [tree, tasks]);

  return (
    <>
      <PageHeader crumbs={[{ label: "Projects" }]} title="Projects" meta="One per client; projects and versions sit under each">
        {me.role === "admin" && <Link className="btn" href="/settings/kra-tree">Manage in KRA / KPI master</Link>}
      </PageHeader>
      <div className="page">
        {err && <ErrorState error={{ message: err }} />}
        {!tree && !err && <div className="stats">{[1, 2, 3].map((i) => <div key={i} className="cardbox"><Skeleton rows={3} /></div>)}</div>}
        <div className="stats">
          {cards.map(({ n, open, running, review, done, total, projects }) => (
            <Link key={n.id} href={`/board?q=${encodeURIComponent(n.name)}`} className="cardbox" style={{ textDecoration: "none", gap: 10 }}>
              <h2><span className="proj-tile" style={{ width: 28, height: 28, fontSize: 11, background: n.is_client ? "var(--proj)" : "var(--subtlest)" }}>{n.name.slice(0, 2).toUpperCase()}</span>{n.name}<small>· {projects} project{projects === 1 ? "" : "s"}</small></h2>
              <div className="row" style={{ gap: 14 }}><span><b style={{ fontSize: 22, color: "var(--navy)" }}>{open}</b> <span className="mini">open</span></span><span><b style={{ fontSize: 22, color: "var(--tint-blue)" }}>{running}</b> <span className="mini">running</span></span><span><b style={{ fontSize: 22, color: "var(--tint-violet)" }}>{review}</b> <span className="mini">in review</span></span><span><b style={{ fontSize: 22, color: "var(--pri-regular)" }}>{done}</b> <span className="mini">done</span></span></div>
              <span className="mini">{total} KPIs in the tree{n.is_client ? ` · ${(n.client_user_ids || []).length} portal user(s)` : ""}</span>
              <span className="mini" style={{ color: "var(--brand)", fontWeight: 700 }}>Open board <Icon n="cright" size={12} /></span>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
