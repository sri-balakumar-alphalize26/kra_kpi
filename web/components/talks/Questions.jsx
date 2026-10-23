"use client";
/* Client Talks › ❓ Questions (Odoo KpiTalksQuestions, kpi_client_talks.js).
   Developer questions, meeting requests and client Discuss questions, and who
   they are with now. A row opens its meeting, its General chat or its task. */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Empty, ErrorState, Lozenge, Modal, PageHeader, Skeleton } from "@/components/ui";
import { ChatTab } from "@/components/task/TaskExtras";
import * as T from "@/lib/services/talks";
import { SearchBox, FilterButton } from "./common";

export default function Questions() {
  const router = useRouter();
  const [filter, setFilter] = useState("open");
  const [search, setSearch] = useState("");
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [chat, setChat] = useState(null);

  const load = useCallback(async () => {
    setData(null);
    try { setData(await T.fetchQuestions(filter, search)); setErr(null); }
    catch (e) { setErr(e); setData({ rows: [], counts: {} }); }
  }, [filter, search]);
  useEffect(() => { load(); }, [load]);

  const counts = data?.counts || {};
  const rows = data?.rows || [];
  const openRow = (q) => {
    if (q.meeting_id) return router.push(`/meetings?id=${q.meeting_id}`);
    if (q.is_general) return setChat(q);
    return router.push(`/board?task=${q.kpi_id}`);
  };

  return (
    <>
      <PageHeader crumbs={[{ label: "Client Talks" }, { label: "Questions" }]} title="❓ Questions"
        meta="Developer questions, meeting requests and client Discuss questions, and who they are with now" />
      <div className="page">
        <div className="toolbar">
          <span className="right" style={{ display: "inline-flex", gap: 8 }}>
            <SearchBox value={search} onChange={setSearch} placeholder="🔍 Search" width={240} />
            <FilterButton on={filter === "open"} onClick={() => setFilter("open")}>Open{counts.open ? ` (${counts.open})` : ""}</FilterButton>
            <FilterButton on={filter === "answered"} onClick={() => setFilter("answered")}>Answered</FilterButton>
            <FilterButton on={filter === "all"} onClick={() => setFilter("all")}>All</FilterButton>
          </span>
        </div>
        {err && <ErrorState error={err} onRetry={load} />}
        {!data && <div className="cardbox"><Skeleton rows={6} /></div>}
        {data && !rows.length && <Empty icon="inbox" title="Nothing here." />}
        {rows.length > 0 && (
          <div className="cardbox table-scroll" style={{ padding: 0 }}>
            <table className="table">
              <thead><tr><th>Task</th><th>Kind</th><th>Question</th><th>Raised by</th><th>With now</th><th>Step</th><th>Waiting</th><th /></tr></thead>
              <tbody>
                {rows.map((q) => (
                  <tr key={q.id} style={q.open ? undefined : { background: "var(--hover)" }}>
                    <td><Lozenge tone="neutral" style={{ textTransform: "none" }}>{q.is_general ? "General" : q.ref}</Lozenge></td>
                    <td style={{ whiteSpace: "nowrap", fontSize: 12.5 }}>{T.kindIcon(q.kind)} {q.kind_label}</td>
                    <td style={{ whiteSpace: "normal", fontSize: 12.5, maxWidth: 380 }}>
                      <div>{q.question}</div>
                      {!q.open && q.answer && <div className="mini">↳ {q.answer}</div>}
                    </td>
                    <td style={{ fontSize: 12.5 }}>{q.raised_by || (q.is_general ? q.client : "")}</td>
                    <td style={{ fontSize: 12.5 }}>{q.with_now}</td>
                    <td>{q.open ? <Lozenge tone="paused" style={{ textTransform: "none" }}>{q.step}</Lozenge> : <Lozenge tone="done" style={{ textTransform: "none" }}>✓ {q.state_label}</Lozenge>}</td>
                    <td style={{ whiteSpace: "nowrap", fontSize: 12.5, color: q.age_min >= 10 ? "var(--danger)" : "var(--subtle)", fontWeight: q.age_min >= 10 ? 600 : 400 }}>{q.open ? T.ageLabel(q.age_min) : "—"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button type="button" className="btn btn-ghost" style={{ height: 28, fontSize: 12.5 }} onClick={() => openRow(q)}>
                        {q.meeting_id ? "📅 Open meeting" : q.is_general ? "💬 Open chat" : "↗ Open task"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Modal open={!!chat} onClose={() => setChat(null)} title={chat ? `💬 ${chat.client} · ${chat.ref || "General"}` : ""} width={640}>
        {chat && <ChatTab key={chat.kpi_id} kpiId={chat.kpi_id} taskRef={chat.ref} />}
      </Modal>
    </>
  );
}
