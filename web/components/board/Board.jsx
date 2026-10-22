"use client";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DndContext, DragOverlay, MeasuringStrategy, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { Avatar, Button, ErrorState, Icon, IconButton, Lozenge, PageHeader, Select, Skeleton, StaleBar, useFlags, useOutside } from "@/components/ui";
import { useMe } from "@/lib/me";
import { useResource } from "@/lib/useFetch";
import { getPref, setPref } from "@/lib/prefs";
import * as S from "@/lib/services/kpiActions";
import { useNow, fmtClock, fmtHMS, liveFromAnchor, presenceLive, productiveLive } from "@/lib/liveTime";
import TaskCard from "@/components/task/TaskCard";
import LiveTick from "@/components/task/LiveTick";
import { actionsFor, dropBlockedReason, dropTargets } from "@/components/task/actions";
import { useTaskActions } from "@/components/task/TaskActions";
import { useFitHeight } from "@/lib/useFitHeight";
import { NowStrip } from "@/components/work/IdleFlow";
import { WorkdayPausedBanner } from "@/components/work/WorkdayButton";

const PAID_PATH = "/kra_kpi/tasks/paid";
const SEL = { border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" };
const EMPTY = [];
const LANE_PAGE = 50; /* cards per lane before "Show more" */
/* Lanes open and stretch when a drag starts (Lane), so drop zones are re-measured during the drag. */
const MEASURE = { droppable: { strategy: MeasuringStrategy.Always } };

/* Plan → Do → Check: the lanes grouped under one arrow header per phase, each
   phase on its own tint. Lanes keep their own order inside a phase; a phase
   with no lane showing is left out. */
const PHASES = [
  { key: "plan", label: "PLAN", color: "#0284C7", lanes: ["regular", "important", "urgent"] },
  { key: "do", label: "DO", color: "#D97706", lanes: ["today", "in_progress", "paused"] },
  { key: "check", label: "CHECK", color: "#15803D", lanes: ["pending_review", "approvals", "awaiting_client", "completed"] },
];
/* The coloured icon tile in each lane header: [icon, colour]. */
const LANE_TILE = {
  today: ["sun", "#2563EB"], pending_review: ["eye", "#8B5CF6"],
  regular: ["list", "#0EA5E9"], important: ["star", "#7C3AED"], urgent: ["bolt", "#EF4444"],
  in_progress: ["play", "#F59E0B"], paused: ["pause", "#64748B"],
  approvals: ["check", "#16A34A"], awaiting_client: ["clock", "#0891B2"], completed: ["flag", "#15803D"],
  paid: ["cash", "#0F766E"],
};
function LaneTile({ k }) {
  const [icon, c] = LANE_TILE[k] || ["list", "#64748B"];
  return <span className="ctile" style={{ "--c": c }}><Icon n={icon} size={15} stroke={2.2} /></span>;
}

/* The KPI Action Board: the app's lanes as Jira columns, all visible, with
   drag-and-drop mapped onto the task routes (actions.js dropTargets). */
export default function Board() {
  const { me } = useMe();
  const flags = useFlags();
  const acts = useTaskActions();
  const sp = useSearchParams();
  const admin = me.role === "admin";
  const [q, setQ] = useState(sp.get("q") || "");
  const [mine, setMine] = useState(() => !admin);
  const [quick, setQuick] = useState(null); /* fresh | recent | overdue | null */
  const [assignee, setAssignee] = useState(null);
  const [priority, setPriority] = useState(""); /* Odoo's Priority filter */
  const [status, setStatus] = useState("");     /* Odoo's Status filter: one lane key */
  const [hideDone, setHideDone] = useState(true);
  const [dragging, setDragging] = useState(null);
  useEffect(() => { const p = getPref("board", me.uid, null); if (p) { if (p.mine != null) setMine(p.mine); if (p.hideDone != null) setHideDone(p.hideDone); } }, [me.uid]);
  useEffect(() => { setPref("board", me.uid, { mine, hideDone }); }, [mine, hideDone, me.uid]);

  const board = useResource(S.TASKS_PATH, { my_tasks_only: false }, { pollMs: 30000 });
  /* Paid: settled work, admin only (the route refuses anyone else). An archive,
     outside the search / filter pipeline, shown with the finished lanes. */
  const showPaid = admin && !hideDone;
  const paid = useResource(PAID_PATH, {}, { enabled: showPaid, pollMs: showPaid ? 60000 : 0, ttl: 30000 });
  const boardRef = useRef(null);
  useFitHeight(boardRef, { ready: !!board.data });
  /* When a search or filter changes, bring the first lane with a match to the
     left edge. Plain data refreshes don't move the board. */
  useEffect(() => {
    if (!q && !quick && !assignee && !mine && !priority && !status) return;
    const t = setTimeout(() => {
      boardRef.current?.querySelector(".col:not(.narrow)")?.scrollIntoView({ inline: "start", block: "nearest", behavior: "smooth" });
    }, 250);
    return () => clearTimeout(t);
  }, [q, quick, assignee, mine, priority, status]);
  const boardRefresh = board.refresh, paidRefresh = paid.refresh;
  useEffect(() => { const on = () => { boardRefresh(); if (showPaid) paidRefresh(); }; window.addEventListener("kpi:refresh", on); return () => window.removeEventListener("kpi:refresh", on); }, [boardRefresh, paidRefresh, showPaid]);
  /* No shared one-second clock here: it re-rendered every card each second.
     Timers tick inside LiveTick; the time-based quick filters use a one-minute
     clock, and only while one is on. */
  const qNow = useNow(!!quick, 60000);
  const tasks = board.data?.tasks || EMPTY;

  const people = useMemo(() => {
    const m = new Map();
    for (const t of tasks) if (t.user_id) m.set(t.user_id, { id: t.user_id, name: t.user_name, n: (m.get(t.user_id)?.n || 0) + 1 });
    /* Chip label: first name, or "First L." when two people share it. */
    const words = (s) => String(s || "").split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
    const list = [...m.values()].map((p) => ({ ...p, first: words(p.name)[0] || p.name || "?" }));
    const dup = (f) => list.filter((p) => p.first.toLowerCase() === f.toLowerCase()).length > 1;
    return list.map((p) => {
      const w = words(p.name);
      return { ...p, label: dup(p.first) && w.length > 1 ? `${p.first} ${w[w.length - 1][0].toUpperCase()}.` : p.first };
    }).sort((a, b) => b.n - a.n);
  }, [tasks]);

  /* Odoo's search also matches the priority word ("urgent"). */
  const matchQ = (t) => S.taskMatchesQuery(t, q) || (!!q.trim() && String(t.priority || "").includes(q.trim().toLowerCase()));
  const filtered = useMemo(() => tasks.filter((t) => {
    if (mine && t.user_id !== me.uid) return false;
    if (assignee && t.user_id !== assignee) return false;
    if (priority && t.priority !== priority) return false;
    if (status && S.laneForTask(t) !== status) return false;
    if (!matchQ(t)) return false;
    if (quick === "fresh" && !S.isFreshTask(t, qNow)) return false;
    if (quick === "recent" && !(t.last_activity && qNow - S.parseServerTs(t.last_activity) < 86400000 * 2)) return false;
    if (quick === "overdue" && !(S.estimateSeconds(t) > 0 && (t.timer_total_seconds || 0) > S.estimateSeconds(t) && t.task_state !== "completed")) return false;
    return true;
  }), [tasks, mine, assignee, priority, status, q, quick, qNow, me.uid]); // eslint-disable-line react-hooks/exhaustive-deps
  /* Lanes are built once per data/filter change. A lane whose cards did not
     change keeps its old array, so its (memoised) column skips the render. */
  const prevLanes = useRef({});
  const lanes = useMemo(() => {
    const g = S.groupIntoLanes(filtered);
    if (status) g.today = []; /* the Status filter shows that one lane only (Odoo) */
    const prev = prevLanes.current;
    for (const k of Object.keys(g)) {
      const a = prev[k];
      if (a && a.length === g[k].length && a.every((x, i) => x === g[k][i])) g[k] = a;
    }
    prevLanes.current = g;
    return g;
  }, [filtered, status]);
  const laneList = S.LANES.filter((l) => !(hideDone && l.key === "completed" && status !== "completed") && !(l.key === "pending_review" && !lanes.pending_review.length && !admin));

  /* Active filters as chips (Odoo: each drops on its own; Clear drops them all). */
  const personName = (id) => people.find((p) => p.id === id)?.name || "Unknown";
  const chips = [
    q.trim() && { key: "q", icon: "search", label: `"${q.trim()}"`, clear: () => setQ("") },
    assignee && { key: "who", icon: "user", label: personName(assignee), clear: () => setAssignee(null) },
    priority && { key: "pri", icon: "flag", label: S.priorityLabel(priority), clear: () => setPriority("") },
    status && { key: "st", icon: "list", label: S.STATUS_FILTERS.find((s) => s.key === status)?.label || status, clear: () => setStatus("") },
  ].filter(Boolean);
  const clearAll = () => { setQ(""); setAssignee(null); setPriority(""); setStatus(""); setQuick(null); };
  const summary = !chips.length ? "" : q.trim()
    ? (filtered.length ? `${filtered.length} task${filtered.length === 1 ? "" : "s"} found for "${q.trim()}"` : `No tasks match "${q.trim()}"`)
    : (filtered.length ? `${filtered.length} of ${tasks.length} tasks` : "No tasks match these filters");

  /* Stable handlers, so memoised lanes and cards skip renders that change nothing. */
  const { openTask, run: runAction } = acts;
  const onOpen = useCallback((t) => openTask(t.id), [openTask]);
  const onAction = useCallback((a, t) => runAction(a, t), [runAction]);

  /* ---- drag and drop ---- */
  const sensors =useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const targets = dragging ? dropTargets(dragging, me, { workdayLocked: acts.workdayLocked }) : {};
  const onDragEnd = useCallback(async (e) => {
    const task = dragging; setDragging(null);
    const to = e.over?.id;
    if (!task || !to) return;
    const tg = dropTargets(task, me, { workdayLocked: acts.workdayLocked })[to];
    if (!tg) { if (to !== S.laneForTask(task) && to !== "today") flags.warn(dropBlockedReason(task, me, to, { workdayLocked: acts.workdayLocked })); return; }
    try {
      if (tg.dialog) await acts.openDialog(tg.dialog, task, { priority: tg.priority });
      else await acts.perform(tg.action, task, tg.priority ? { priority: tg.priority } : {});
    } catch (_) {}
  }, [dragging, me, acts, flags]);

  const searchBox = <label className="search" style={{ margin: 0, width: 240, flex: "none" }}><Icon n="search" size={16} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by ref, name or developer" aria-label="Search this board" style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", width: "100%" }} /></label>;
  const liveData = acts.live.data;
  const running = (liveData?.active_tasks?.length ? liveData.active_tasks : liveData?.active_task ? [liveData.active_task] : []);
  const workdayOpen = acts.workdayOpen;
  const wd = acts.workday.data || {};

  /* Odoo warns before closing or reloading the tab while a task runs or the
     workday is open. Only a warning: closing the tab stops nothing. */
  const warnLeave = running.length > 0 || workdayOpen;
  useEffect(() => {
    if (!warnLeave) return;
    const on = (e) => { e.preventDefault(); e.returnValue = ""; return ""; };
    window.addEventListener("beforeunload", on);
    return () => window.removeEventListener("beforeunload", on);
  }, [warnLeave]);

  return (
    <div className="board-wrap">
      <PageHeader crumbs={[{ label: "Projects" }, { label: admin ? "All work" : "My work" }]} title="Board">
        {admin && board.data?.self_pending_count > 0 && <span className="chip" title="Self-created tasks awaiting your Accept"><Icon n="clock" size={14} /> Pending review: {board.data.self_pending_count}</span>}
        {running.length > 1 && <Button size="sm" icon="pause" onClick={() => acts.pauseAll()} title="Pause every task you have running, with one reason">Pause all ({running.length})</Button>}
      </PageHeader>
      {wd.reopened_reason && <div className="reopen-line"><Icon n="swap" size={13} /> Workday reopened{wd.reopened_by ? ` by ${wd.reopened_by}` : ""}: <span style={{ color: "var(--subtle)" }}>{wd.reopened_reason}</span></div>}
      <WorkdayPausedBanner />
      {(running.length > 0 || (workdayOpen && liveData?.login_raw)) && (
        <div className="run-banner" role="status">
          {running.length > 1 && <b><Icon n="live" size={14} /> Multi-tasking {running.length} tasks:</b>}
          {running.map((r) => (
            <span key={r.id} className="run-t"><span className="pulse" />{r.external_ref ? `${r.external_ref} ` : ""}{r.name} · <LiveTick fn={(n) => fmtClock(liveFromAnchor(r.timer_start, r.timer_total_seconds, n))} /></span>
          ))}
          {running.length > 0 && <span>A task is running. It keeps counting until you Pause, Complete, Switch task or End workday — closing this tab won't stop it.</span>}
          {liveData?.login_raw && <span className="totals">Presence <b><LiveTick fn={(n) => fmtHMS(presenceLive(liveData, n))} /></b> · Productive <b><LiveTick fn={(n) => fmtHMS(productiveLive(liveData, n))} /></b></span>}
        </div>
      )}
      <NowStrip />
      {acts.workdayLocked && <div className="callout readonly"><Icon n="info" size={18} /><span style={{ flex: 1 }}>Your workday isn't started — the board is read-only until you start it.</span></div>}
      {admin && (
        <div className="filters" style={{ marginBottom: 8 }}>
          {searchBox}
          {people.length > 0 && <PeopleFilter people={people} value={assignee} onChange={setAssignee} />}
        </div>
      )}
      <div className="filters" style={{ flexWrap: "wrap", marginBottom: chips.length ? 6 : undefined }}>
        {!admin && searchBox}
        <span className="input" style={{ height: 32, width: 150 }}><Select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority" style={SEL}><option value="">All priorities</option>{S.PRIORITIES.slice().reverse().map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}</Select></span>
        <span className="input" style={{ height: 32, width: 170 }}><Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" style={SEL}><option value="">All statuses</option>{S.STATUS_FILTERS.filter((s) => admin || s.key !== "pending_review" || lanes.pending_review.length).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</Select></span>
        <button className={`pill ${mine ? "on" : ""}`} onClick={() => setMine((v) => !v)}>Only my tasks</button>
        <button className={`pill ${quick === "recent" ? "on" : ""}`} onClick={() => setQuick(quick === "recent" ? null : "recent")}>Recently updated</button>
        <button className={`pill ${quick === "fresh" ? "on" : ""}`} onClick={() => setQuick(quick === "fresh" ? null : "fresh")}>Fresh (24h)</button>
        <button className={`pill ${quick === "overdue" ? "on" : ""}`} onClick={() => setQuick(quick === "overdue" ? null : "overdue")}>Over estimate</button>
        <button className={`pill ${!hideDone ? "on" : ""}`} onClick={() => setHideDone((v) => !v)}>{admin ? "Show completed & paid" : "Show completed"}</button>
        {(chips.length > 0 || quick) && <Button size="sm" kind="ghost" icon="x" onClick={clearAll}>Clear</Button>}
        <span style={{ marginLeft: "auto" }} className="mini">Showing {filtered.length} of {tasks.length} tasks</span>
        <div className="seg" style={{ margin: 0 }}><span className="on">Board</span><a href="/list" style={{ textDecoration: "none", color: "inherit" }}><span>List</span></a></div>
      </div>
      {chips.length > 0 && (
        <div className="fchips">
          <span className="mini">Active filters:</span>
          {chips.map((c) => <span key={c.key} className="fchip"><Icon n={c.icon} size={12} />{c.label}<button type="button" aria-label={`Remove filter ${c.label}`} onClick={c.clear}><Icon n="x" size={12} /></button></span>)}
          <span className={`fsum ${filtered.length ? "ok" : "none"}`}><Icon n="filter" size={12} /> {summary}</span>
        </div>
      )}
      {board.error && !board.data && <ErrorState error={board.error} onRetry={board.refresh} />}
      {board.stale && <StaleBar error={board.error} onRetry={board.refresh} />}
      {board.loading && !board.data && <div className="board">{[1, 2, 3, 4].map((i) => <section key={i} className="col"><header className="col-h">&nbsp;</header><div className="col-b" style={{ padding: 12 }}><Skeleton rows={4} /></div></section>)}</div>}
      {board.data && (
        <DndContext sensors={sensors} measuring={MEASURE} onDragStart={(e) => setDragging(tasks.find((t) => t.id === e.active.id) || null)} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
          <div className={`board pdc ${dragging ? "is-dragging" : ""}`} ref={boardRef}>
            {PHASES.map((ph) => {
              const own = laneList.filter((l) => ph.lanes.includes(l.key));
              const paidHere = ph.key === "check" && showPaid && !status;
              if (!own.length && !paidHere) return null;
              /* Today repeats tasks that also sit in another lane: count each once. */
              const n = new Set(own.flatMap((l) => lanes[l.key].map((t) => t.id))).size;
              return (
                <section key={ph.key} className="pdc-phase" style={{ "--pc": ph.color }}>
                  <div className="pdc-head">{ph.label}<small>{n} task{n === 1 ? "" : "s"}</small></div>
                  <div className="pdc-cols">
                    {own.map((l) => (
                      <Lane key={l.key} lane={l} items={lanes[l.key]} dragging={dragging} allowed={targets[l.key] != null} hint={targets[l.key]?.hint} blocked={dragging && !targets[l.key] ? dropBlockedReason(dragging, me, l.key, { workdayLocked: acts.workdayLocked }) : null} selectedId={+sp.get("task")} onOpen={onOpen} onAction={onAction} workdayLocked={acts.workdayLocked} />
                    ))}
                    {paidHere && <PaidLane res={paid} />}
                  </div>
                </section>
              );
            })}
          </div>
          <DragOverlay dropAnimation={null}>{dragging ? <div className="drag-ghost"><TaskCard task={dragging} /></div> : null}</DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

/* Paid (admin): read-only cards from /kra_kpi/tasks/paid — what was billed,
   what it took against its estimate, the amount, and when it was paid. */
function PaidLane({ res }) {
  const [mode, setMode] = useState("auto");
  const items = res.data?.status === false ? [] : (res.data?.tasks || []);
  const narrow = mode === "folded" || (mode === "auto" && items.length === 0 && !!res.data);
  const failed = res.error || res.data?.status === false;
  return (
    <section className={`col ${narrow ? "narrow" : ""}`}>
      <header className="col-h" onClick={narrow ? () => setMode("open") : undefined} onDoubleClick={narrow ? undefined : () => setMode("folded")} title={narrow ? "Click to open" : "Double-click to fold"}>
        <LaneTile k="paid" />Paid <em>{items.length}{res.data?.truncated ? "+" : ""}</em>
        {!narrow && <IconButton className="collapse" icon="cleft" label="Fold lane" size={14} onClick={() => setMode("folded")} />}
        {narrow && <IconButton className="collapse" icon="cright" label="Open lane" size={14} onClick={(e) => { e.stopPropagation(); setMode("open"); }} />}
      </header>
      <div className="col-b">
        {!res.data && !failed && <div style={{ padding: 12 }}><Skeleton rows={3} /></div>}
        {failed && <div className="empty">{res.data?.message || res.error?.message || "Paid lane unavailable"}</div>}
        {items.map((pt) => {
          const est = S.estimateSeconds(pt);
          const over = est > 0 && (pt.timer_total_seconds || 0) > est;
          return (
            <article key={pt.id} className="card paid-card">
              <p>{pt.external_ref && <span className="ref" style={{ marginRight: 6 }}>{pt.external_ref}</span>}{pt.name}</p>
              <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                {pt.client_name && <Lozenge tone="todo">{pt.client_name}</Lozenge>}
                {pt.amount ? <Lozenge tone="done" style={{ textTransform: "none" }}>{pt.currency} {Number(pt.amount).toFixed(2)}</Lozenge> : null}
              </div>
              <span className="mini">
                <span style={over ? { color: "var(--over)", fontWeight: 800 } : undefined}>{S.fmtHM(pt.timer_total_seconds)}</span>
                {est > 0 ? ` · est ${pt.estimate_display}` : " · no estimate"}
              </span>
              <span className="mini">{pt.client_paid_on ? `client ${String(pt.client_paid_on).slice(0, 11)} → ` : ""}confirmed {String(pt.paid_on || "").slice(0, 11) || "—"}{pt.invoice_name ? ` · ${pt.invoice_name}` : ""}</span>
              {pt.user_name && <span className="mini"><Avatar name={pt.user_name} size={18} /> {pt.user_name}</span>}
            </article>
          );
        })}
        {res.data && !failed && !items.length && <div className="empty">Nothing paid yet.</div>}
        {res.data?.truncated && <div className="empty">Showing the most recent {items.length} only.</div>}
      </div>
    </section>
  );
}

/* One line of person chips: "All", as many people as fit, then "+N more"
   for the rest. A hidden copy of every chip is measured to work out how many
   fit; it re-measures when the row is resized. Someone picked from "more"
   takes the last visible slot so the selection is always on screen. */
function PeopleFilter({ people, value, onChange }) {
  const rowRef = useRef(null);
  const measureRef = useRef(null);
  const [fit, setFit] = useState(people.length);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const menuRef = useOutside(close);

  useLayoutEffect(() => {
    const row = rowRef.current, box = measureRef.current;
    if (!row || !box) return;
    const GAP = 6;
    const measure = () => {
      const kids = [...box.children];
      const allW = kids[0].offsetWidth, moreW = kids[kids.length - 1].offsetWidth;
      const chipW = kids.slice(1, -1).map((k) => k.offsetWidth);
      const avail = row.clientWidth - allW - GAP;
      let used = 0, n = 0;
      for (; n < chipW.length; n++) {
        const restAfter = n + 1 < chipW.length ? GAP + moreW : 0;
        if (used + chipW[n] + restAfter > avail) break;
        used += chipW[n] + GAP;
      }
      setFit(Math.max(1, n));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
  }, [people]);

  let shown = people.slice(0, fit);
  if (value && !shown.some((p) => p.id === value)) {
    const sel = people.find((p) => p.id === value);
    if (sel) shown = [...shown.slice(0, Math.max(0, fit - 1)), sel];
  }
  const rest = people.filter((p) => !shown.includes(p));
  const chip = (p, extra = {}) => (
    <button key={p.id} className={`who-chip ${value === p.id ? "on" : ""}`} title={`${p.name} · ${p.n} tasks`} aria-pressed={value === p.id} onClick={() => onChange(value === p.id ? null : p.id)} {...extra}>
      <Avatar name={p.name} uid={p.id} size={20} />{p.label}<em>{p.n}</em>
    </button>
  );

  return (
    <div className="who" ref={rowRef} aria-label="Filter by person">
      <div className="who-measure" ref={measureRef} aria-hidden="true">
        <span className="who-chip txt">All</span>
        {people.map((p) => chip(p, { tabIndex: -1 }))}
        <span className="who-chip txt">+{people.length} more<Icon n="chev" size={14} /></span>
      </div>
      <button className={`who-chip txt ${value == null ? "on" : ""}`} aria-pressed={value == null} onClick={() => onChange(null)}>All</button>
      {shown.map((p) => chip(p))}
      {rest.length > 0 && (
        <div className="menu-wrap" ref={menuRef}>
          <button className="who-chip txt" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>+{rest.length} more<Icon n="chev" size={14} /></button>
          {open && (
            <div className="menu" role="menu" style={{ maxHeight: 340, overflowY: "auto" }}>
              {rest.map((p) => (
                <button key={p.id} className="mi" role="menuitem" title={p.name} onClick={() => { onChange(p.id); setOpen(false); }}>
                  <Avatar name={p.name} uid={p.id} size={22} /><span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span><span className="mini">{p.n}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* [[task, indented]] with each bug / update moved to just after its parent
   requirement when that requirement is in the same list. */
function nestUnderParent(items) {
  const here = new Set(items.map((t) => t.id));
  const kids = new Map();
  for (const t of items) if (t.parent_kpi_id && here.has(t.parent_kpi_id)) (kids.get(t.parent_kpi_id) || kids.set(t.parent_kpi_id, []).get(t.parent_kpi_id)).push(t);
  const out = [];
  for (const t of items) {
    if (t.parent_kpi_id && here.has(t.parent_kpi_id)) continue;
    out.push([t, false]);
    for (const k of kids.get(t.id) || []) out.push([k, true]);
  }
  return out;
}

const Lane = memo(function Lane({ lane, items, dragging, allowed, hint, blocked, selectedId, onOpen, onAction, workdayLocked }) {
  const { setNodeRef, isOver } = useDroppable({ id: lane.key });
  /* Odoo style: "auto" folds the lane into a thin strip while it has no cards;
     "open" / "folded" are the user's own choice and stick until changed.
     While a card is dragged, every lane it may drop on opens, so it is easy to hit. */
  const [mode, setMode] = useState("auto");
  const home = dragging && (S.laneForTask(dragging) === lane.key || lane.key === "today");
  const narrow = !(dragging && allowed) && (mode === "folded" || (mode === "auto" && items.length === 0));
  /* A long lane draws LANE_PAGE cards, then "Show more". */
  const [limit, setLimit] = useState(LANE_PAGE);
  /* A bug / update sits right under its REQ, indented, when both are in this lane. */
  const nested = useMemo(() => nestUnderParent(items), [items]);
  const shown = nested.length > limit ? nested.slice(0, limit) : nested;
  const hidden = items.length - shown.length;
  const cls = ["col", narrow ? "narrow" : "", dragging ? (allowed ? "drop-ok" : home ? "" : "drop-no") : "", isOver && dragging && !home ? "over" : ""].join(" ");
  return (
    <section ref={setNodeRef} className={cls}>
      <header className="col-h" onClick={narrow ? () => setMode("open") : undefined} onDoubleClick={narrow ? undefined : () => setMode("folded")} title={narrow ? "Click to open" : "Double-click to fold"}>
        <LaneTile k={lane.key} />{lane.label} <em>{items.length}</em>
        {!narrow && <IconButton className="collapse" icon="cleft" label="Fold lane" size={14} onClick={() => setMode("folded")} />}
        {narrow && <IconButton className="collapse" icon="cright" label="Open lane" size={14} onClick={(e) => { e.stopPropagation(); setMode("open"); }} />}
      </header>
      <div className="col-b">
        {dragging && allowed && hint && <div className="drop-hint" role="note"><Icon n="check" size={13} />{hint}</div>}
        {dragging && !allowed && !home && isOver && blocked && <div className="drop-hint no" role="note"><Icon n="x" size={13} />{blocked}</div>}
        {shown.map(([t, child]) => <DraggableCard key={`${lane.key}-${t.id}`} task={t} child={child} selected={selectedId === t.id} onOpen={onOpen} onAction={onAction} workdayLocked={workdayLocked} isDragging={dragging?.id === t.id} />)}
        {hidden > 0 && <div style={{ display: "flex", justifyContent: "center", padding: "4px 0 8px" }}><Button size="sm" kind="ghost" onClick={() => setLimit((n) => n + LANE_PAGE)}>Show {Math.min(LANE_PAGE, hidden)} more</Button></div>}
        {!items.length && <div className="empty">{lane.key === "today" ? "Nothing worked on yet today" : "No tasks"}</div>}
      </div>
    </section>
  );
});

/* Memoised: a poll or a timer tick elsewhere leaves an unchanged card alone. */
const DraggableCard = memo(function DraggableCard({ task, child, selected, onOpen, onAction, workdayLocked, isDragging }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: task.id, data: { task } });
  const { me } = useMe();
  const cardActs = useMemo(() => actionsFor(task, me, { workdayLocked }).filter((a) => a.card), [task, me, workdayLocked]);
  return (
    <div ref={setNodeRef} {...attributes} style={{ outline: "none", marginLeft: child ? 18 : 0 }}>
      <TaskCard task={task} selected={selected} onOpen={onOpen} dragging={isDragging} dragHandle={listeners} actions={cardActs} onAction={onAction} />
    </div>
  );
});
