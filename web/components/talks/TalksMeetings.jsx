"use client";
/* Client Talks › 📅 Meetings (Odoo KpiTalksMeetings, kpi_client_talks.js).
   Every meeting by date. Full shows each one open; Compact is one closed row
   each (tap to open); the choice is remembered in this browser. */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ErrorState, Lozenge, Modal, PageHeader, Skeleton } from "@/components/ui";
import { ChatTab } from "@/components/task/TaskExtras";
import * as T from "@/lib/services/talks";
import { MeetingDays } from "./MeetingCards";
import { TalkTabs, SearchBox, FilterButton } from "./common";

const VIEW_KEY = "kpi_talks_meetings_view";
const FILTERS = [["upcoming", "Upcoming"], ["past", "Past"], ["all", "All"]];
const savedView = () => { try { return window.localStorage.getItem(VIEW_KEY) === "compact" ? "compact" : "full"; } catch { return "full"; } };

export default function TalksMeetings() {
  const router = useRouter();
  const [tab, setTab] = useState("task");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [view, setViewState] = useState("full");
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [chat, setChat] = useState(null);
  useEffect(() => { setViewState(savedView()); }, []);
  const setView = (v) => { setViewState(v); try { window.localStorage.setItem(VIEW_KEY, v); } catch { /* not remembered, still switches */ } };

  const load = useCallback(async () => {
    setData(null);
    try { setData(await T.fetchTalkMeetings(tab, filter, search)); setErr(null); }
    catch (e) { setErr(e); setData({ days: [], counts: {} }); }
  }, [tab, filter, search]);
  useEffect(() => { load(); }, [load]);

  const counts = data?.counts || {};
  const openBoard = (m) => (m.is_general ? setChat(m) : router.push(`/board?task=${m.kpi_id}`));

  return (
    <>
      <PageHeader crumbs={[{ label: "Client Talks" }, { label: "Meetings" }]} title={<>📅 Meetings{counts.upcoming > 0 && <Lozenge tone="review" style={{ marginLeft: 8, textTransform: "none" }}>{counts.upcoming} upcoming</Lozenge>}</>} />
      <div className="page">
        <div className="toolbar">
          <span className="right" style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
            <span style={{ display: "inline-flex" }} role="group" aria-label="View">
              <FilterButton on={view === "full"} onClick={() => setView("full")}>▦ Full</FilterButton>
              <FilterButton on={view === "compact"} onClick={() => setView("compact")}>☰ Compact</FilterButton>
            </span>
            <SearchBox value={search} onChange={setSearch} placeholder="🔍 Search client, REQ, words in summary" width={300} />
            {FILTERS.map(([k, label]) => <FilterButton key={k} on={filter === k} onClick={() => setFilter(k)}>{label}</FilterButton>)}
          </span>
        </div>
        <TalkTabs tab={tab} counts={counts} onChange={setTab} />
        {err && <ErrorState error={err} onRetry={load} />}
        {!data && <div className="cardbox"><Skeleton rows={6} /></div>}
        {data && !data.days.length && (
          <div className="cardbox mini">
            {tab === "general" ? "No general meetings. They are the ones a client asked for without picking a task (\"Common, whole server\" or \"Other / a new topic\")." : "No meetings here."}
          </div>
        )}
        {data && data.days.length > 0 && <MeetingDays key={view} days={data.days} compact={view === "compact"} onOpen={openBoard} />}
      </div>
      <Modal open={!!chat} onClose={() => setChat(null)} title={chat ? `💬 ${chat.client} · ${chat.ref}` : ""} width={640}>
        {chat && <ChatTab key={chat.kpi_id} kpiId={chat.kpi_id} taskRef={chat.ref} />}
      </Modal>
    </>
  );
}
