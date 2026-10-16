"use client";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Avatar, Button, ErrorState, Icon, Lozenge, PageHeader, Skeleton, StaleBar, stateTone } from "@/components/ui";
import { useMe } from "@/lib/me";
import { useResource } from "@/lib/useFetch";
import * as S from "@/lib/services/kpiActions";
import { fmtHM, laneForTask, estimateSeconds } from "@/lib/services/kpiActions";
import { since } from "@/lib/liveTime";
import { useTaskActions } from "@/components/task/TaskActions";

/* The same tasks as the board, as a sortable table grouped by lane. */
const COLS = [
  ["ref", "Key"], ["name", "Task"], ["lane", "Status"], ["priority", "Priority"], ["user_name", "Assignee"], ["client_name", "Client / project"],
  ["estimate", "Estimate", "num"], ["spent", "Logged", "num"], ["today_seconds", "Today", "num"], ["last_activity", "Last activity"], ["deadline", "Deadline"],
];
const ROW_PAGE = 100;
export default function TaskList() {
  const { me } = useMe();
  const acts = useTaskActions();
  const sp = useSearchParams();
  const admin = me.role === "admin";
  const [q, setQ] = useState(sp.get("q") || "");
  const [tab, setTab] = useState("all");
  const [sort, setSort] = useState({ key: "last_activity", dir: -1 });
  const [grouped, setGrouped] = useState(true);
  const board = useResource(S.TASKS_PATH, { my_tasks_only: false }, { pollMs: 30000 });
  const paid = useResource("/kra_kpi/tasks/paid", {}, { enabled: admin && tab === "paid" });
  const boardRefresh = board.refresh;
  useEffect(() => { const on = () => boardRefresh(); window.addEventListener("kpi:refresh", on); return () => window.removeEventListener("kpi:refresh", on); }, [boardRefresh]);

  const source = tab === "paid" ? (paid.data?.tasks || []) : (board.data?.tasks || []);
  const rows = useMemo(() => source
    .filter((t) => (tab !== "mine" || t.user_id === me.uid) && S.taskMatchesQuery(t, q))
    .map((t) => ({ t, ref: t.external_ref || `#${t.id}`, lane: laneForTask(t), estimate: estimateSeconds(t), spent: t.timer_total_seconds || 0 }))
    .sort((a, b) => {
      const k = sort.key; const av = a[k] ?? a.t[k] ?? ""; const bv = b[k] ?? b.t[k] ?? "";
      if (av === bv) return 0; if (av === "" || av == null) return 1; if (bv === "" || bv == null) return -1;
      return (av < bv ? -1 : 1) * sort.dir;
    }), [source, tab, q, sort, me.uid]);
  const groups = useMemo(() => {
    if (!grouped) return [{ key: "all", label: null, rows }];
    const m = new Map();
    for (const r of rows) { const k = r.lane; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return S.LANES.filter((l) => l.key !== "today" && m.has(l.key)).map((l) => ({ key: l.key, label: l.label, rows: m.get(l.key) }));
  }, [rows, grouped]);

  /* A long list draws ROW_PAGE rows, then "Show more"; each group takes what
     is left of that budget, in order, and keeps its full count in the header. */
  const [limit, setLimit] = useState(ROW_PAGE);
  useEffect(() => { setLimit(ROW_PAGE); }, [tab, q, sort, grouped]);
  let left = limit;
  const budget = groups.map((g) => { const n = Math.min(g.rows.length, left); left -= n; return n; });

  const th = (k, label, cls) => (
    <th key={k} className={cls || ""} style={{ cursor: "pointer", userSelect: "none" }} onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? -s.dir : -1 }))}>
      {label}{sort.key === k ? (sort.dir < 0 ? " ↓" : " ↑") : ""}
    </th>
  );

  return (
    <>
      <PageHeader crumbs={[{ label: "Projects" }, { label: admin ? "All work" : "My work" }]} title="All tasks">
      </PageHeader>
      <div className="page">
        <div className="toolbar">
          <label className="search" style={{ margin: 0, width: 240 }}><Icon n="search" size={16} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks" aria-label="Search tasks" style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", width: "100%" }} /></label>
          <div className="tabs">
            <span className={tab === "all" ? "on" : ""} onClick={() => setTab("all")} style={{ cursor: "pointer" }}>All <em>{board.data?.tasks?.length ?? "…"}</em></span>
            <span className={tab === "mine" ? "on" : ""} onClick={() => setTab("mine")} style={{ cursor: "pointer" }}>Mine <em>{board.data?.tasks?.filter((t) => t.user_id === me.uid).length ?? "…"}</em></span>
            {admin && <span className={tab === "paid" ? "on" : ""} onClick={() => setTab("paid")} style={{ cursor: "pointer" }}>Paid{paid.data?.tasks ? <em>{paid.data.tasks.length}{paid.data.truncated ? "+" : ""}</em> : null}</span>}
          </div>
          <label className="chk" style={{ marginLeft: 4 }}><input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} />Group by status</label>
          <span className="right"><span className="mini">{rows.length} tasks</span><div className="seg" style={{ margin: 0 }}><a href="/board" style={{ textDecoration: "none", color: "inherit" }}><span>Board</span></a><span className="on">List</span></div></span>
        </div>
        {board.error && !board.data && <ErrorState error={board.error} onRetry={board.refresh} />}
        {board.stale && <StaleBar error={board.error} onRetry={board.refresh} />}
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {!board.data && !board.error ? <div style={{ padding: 16 }}><Skeleton rows={6} /></div> : (
            <table className="table">
              <thead><tr>{COLS.map(([k, l, c]) => th(k, l, c))}</tr></thead>
              <tbody>
                {groups.map((g, i) => budget[i] > 0 && (
                  <GroupRows key={g.key} group={g} limit={budget[i]} admin={admin} onOpen={(t) => acts.openTask(t.id)} selected={+sp.get("task")} />
                ))}
                {rows.length > limit && <tr><td colSpan={COLS.length} style={{ textAlign: "center" }}><Button size="sm" kind="ghost" onClick={() => setLimit((n) => n + ROW_PAGE)}>Show {Math.min(ROW_PAGE, rows.length - limit)} more</Button></td></tr>}
                {!rows.length && <tr><td colSpan={COLS.length} className="empty">No tasks match.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function GroupRows({ group, limit, onOpen, selected }) {
  return (
    <>
      {group.label && <tr className="group"><td colSpan={COLS.length}>{group.label} · {group.rows.length}</td></tr>}
      {(group.rows.length > limit ? group.rows.slice(0, limit) : group.rows).map(({ t, ref, lane, estimate, spent }) => {
        const [tone, label] = lane === "approvals" ? ["review", "In review"] : lane === "pending_review" ? ["review", "Pending review"] : stateTone(t.task_state);
        const over = estimate > 0 && spent > estimate;
        return (
          <tr key={t.id} className={selected === t.id ? "sel" : ""} style={{ cursor: "pointer" }} onClick={() => onOpen(t)}>
            <td><span className="ref">{ref}</span></td>
            <td><b>{t.name}</b>{t.self_needs_resume_reason ? <> <Lozenge tone="danger">Sent back</Lozenge></> : null}</td>
            <td><Lozenge tone={tone}>{label}</Lozenge></td>
            <td style={{ color: t.priority === "urgent" ? "var(--pri-urgent)" : t.priority === "important" ? "var(--pri-important)" : "var(--pri-regular)", fontWeight: 800 }}>{t.priority === "urgent" ? "▲▲ Urgent" : t.priority === "important" ? "▲ Important" : "– Regular"}</td>
            <td>{t.user_name ? <><Avatar name={t.user_name} id={t.user_id} size={22} /> {t.user_name}</> : <span className="mini">Unassigned</span>}</td>
            <td>{t.client_name || "—"}{t.project_name ? ` · ${t.project_name}` : ""}</td>
            <td className="num">{fmtHM(estimate)}</td>
            <td className="num" style={over ? { color: "var(--over)", fontWeight: 800 } : undefined}>{fmtHM(spent)}</td>
            <td className="num">{t.today_seconds ? fmtHM(t.today_seconds) : "—"}</td>
            <td>{t.last_activity ? since(t.last_activity) : "—"}</td>
            <td>{t.deadline || "—"}</td>
          </tr>
        );
      })}
    </>
  );
}
