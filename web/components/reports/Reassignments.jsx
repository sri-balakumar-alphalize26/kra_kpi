"use client";
import { useEffect, useMemo, useState } from "react";
import { Avatar, Button, ErrorState, Icon, Lozenge, PageHeader, Skeleton } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import * as R from "@/lib/services/reports";
import { useTaskActions } from "@/components/task/TaskActions";
import ReportsNav from "./ReportsNav";

/* Read-only log of every reassignment, newest first, a page at a time.
   The route takes a `limit` but no offset yet, so the pages are cut from what
   has been fetched, and "Load older" asks for a bigger batch. */
const PAGE = 50;
const BATCH = 300;

export default function Reassignments() {
  const acts = useTaskActions();
  const [limit, setLimit] = useState(BATCH);
  const hist = useResource(R.REASSIGN_PATH, { limit }, { ttl: 60000 });
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  /* {status:false, message} is a refusal, not data. */
  const histData = hist.data?.status === false ? null : hist.data;
  const histErr = hist.error || (hist.data?.status === false ? new Error(hist.data.message || "Could not load the reassignment history.") : null);
  const all = useMemo(() => histData?.history || [], [histData]);
  const rows = useMemo(() => all.filter((h) => !q || `${h.kpi_task} ${h.kpi_name} ${h.previous_assignee} ${h.new_assignee} ${h.reassigned_by} ${h.reason}`.toLowerCase().includes(q.toLowerCase())), [all, q]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  useEffect(() => { setPage(0); }, [q]);
  useEffect(() => { if (page > pages - 1) setPage(pages - 1); }, [page, pages]);
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);
  /* A full batch means there may be older rows the server did not send. */
  const mayHaveMore = !!histData && all.length >= limit;

  return (
    <>
      <PageHeader crumbs={[{ label: "Reports" }, { label: "Reassignment history" }]} title="Reassignment history">
        <label className="search" style={{ margin: 0, width: 240 }}><Icon n="search" size={16} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Task or person" aria-label="Search" style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", width: "100%" }} /></label>
      </PageHeader>
      <div className="page">
        <ReportsNav />
        {histErr && !histData && <ErrorState error={histErr} onRetry={hist.refresh} />}
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {!histData && !histErr ? <div style={{ padding: 16 }}><Skeleton rows={6} /></div> : !histData ? null : (
            <table className="table">
              <thead><tr><th>When</th><th>Task</th><th>From</th><th></th><th>To</th><th>By</th><th style={{ width: "30%" }}>Reason</th><th>Was</th></tr></thead>
              <tbody>{shown.map((h) => (
                <tr key={h.id} style={{ cursor: "pointer" }} onClick={() => h.kpi_id && acts.openTask(h.kpi_id)}>
                  <td>{h.reassignment_date}</td><td><span className="ref">{h.kpi_task}</span> <b>{h.kpi_name}</b></td>
                  <td><Avatar name={h.previous_assignee} size={22} /> {h.previous_assignee}</td><td>→</td><td><Avatar name={h.new_assignee} size={22} /> {h.new_assignee}</td>
                  <td>{h.reassigned_by}</td><td style={{ whiteSpace: "normal" }}>{h.reason || "—"}</td>
                  <td><Lozenge tone={h.was_paused ? "paused" : "todo"}>{h.was_paused ? `Paused · ${h.pause_reason || ""}` : (h.previous_state || "").replace(/_/g, " ")}</Lozenge>{h.time_spent && <span className="mini"> · {h.time_spent}</span>}</td>
                </tr>
              ))}{hist.data && !rows.length && <tr><td colSpan={8} className="empty">No reassignments recorded.</td></tr>}</tbody>
            </table>
          )}
        </div>
        {histData && (
          <div className="toolbar">
            <span className="mini">{rows.length ? `${page * PAGE + 1}–${Math.min(rows.length, (page + 1) * PAGE)} of ${rows.length}` : "0"}{q ? ` matching (of ${all.length} loaded)` : ` reassignments${mayHaveMore ? " loaded" : ""}`}</span>
            <span className="right">
              <Button size="sm" onClick={() => setPage(0)} disabled={page === 0}>First</Button>
              <Button size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>Previous</Button>
              <span className="mini">Page {page + 1} of {pages}</span>
              <Button size="sm" onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}>Next</Button>
              {mayHaveMore && <Button size="sm" kind="ghost" busy={hist.loading} onClick={() => setLimit((l) => l + BATCH)}>Load older</Button>}
            </span>
          </div>
        )}
      </div>
    </>
  );
}
