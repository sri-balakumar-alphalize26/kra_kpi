"use client";
/* Client Talks › 💬 Discussions (Odoo KpiTalksDiscussions, kpi_client_talks.js).
   Every task chat on the left, waiting first; tap one and its whole history
   shows on the right, by date (each date closed until tapped) and then in
   coloured talks: a new talk after an hour of quiet. "↗ Open task" opens the
   task on the board; a General chat ("Something else" in WhatsApp 💬 Discuss)
   opens its chat, as the board's 💬 General questions does. */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ErrorState, Lozenge, Modal, PageHeader, Skeleton } from "@/components/ui";
import { href } from "@/lib/api";
import { ChatTab } from "@/components/task/TaskExtras";
import * as T from "@/lib/services/talks";
import { TalkTabs, SearchBox, FilterButton } from "./common";

/* Chat files come back as Odoo paths (/kpi/chat/file/<id>): through the proxy. */
const fileUrl = (u) => (String(u || "").startsWith("/web/") ? u : href(u));

export default function Discussions() {
  const router = useRouter();
  const [tab, setTab] = useState("task");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [chat, setChat] = useState(null);

  const load = useCallback(async () => {
    setData(null);
    try { setData(await T.fetchDiscussions(tab, filter, search)); setErr(null); }
    catch (e) { setErr(e); setData({ rows: [], counts: {} }); }
  }, [tab, filter, search]);
  useEffect(() => { load(); }, [load]);

  const counts = data?.counts || {};
  const waitingCount = (counts.waiting_task || 0) + (counts.waiting_general || 0);
  const rows = data?.rows || [];
  const openThread = async (row) => {
    setOpen({ ...row, days: [] });
    setThreadLoading(true);
    try { setOpen(await T.fetchThread(row.kpi_id)); }
    catch (e) { setErr(e); } finally { setThreadLoading(false); }
  };
  const openBoard = (row) => (row.is_general ? setChat(row) : router.push(`/board?task=${row.kpi_id}`));

  return (
    <>
      <PageHeader crumbs={[{ label: "Client Talks" }, { label: "Discussions" }]} title={<>💬 Discussions{waitingCount > 0 && <Lozenge tone="danger" style={{ marginLeft: 8, textTransform: "none" }}>{waitingCount} waiting</Lozenge>}</>} />
      <div className="page">
        <div className="toolbar">
          <span className="right" style={{ display: "inline-flex", gap: 8 }}>
            <SearchBox value={search} onChange={setSearch} placeholder="🔍 Search client, REQ, words" width={260} />
            <FilterButton on={filter === "waiting"} onClick={() => setFilter("waiting")}>Waiting</FilterButton>
            <FilterButton on={filter === "all"} onClick={() => setFilter("all")}>All</FilterButton>
          </span>
        </div>
        <TalkTabs tab={tab} counts={counts} onChange={(t) => { setTab(t); setOpen(null); }} />
        {err && <ErrorState error={err} onRetry={load} />}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 1fr) minmax(0, 2fr)", gap: 12, alignItems: "start" }}>
          <div>
            {!data && <div className="cardbox"><Skeleton rows={5} /></div>}
            {data && !rows.length && (
              <div className="cardbox mini">
                {tab === "general" ? "No general questions yet. When a client picks \"Something else\" in WhatsApp 💬 Discuss, it shows here."
                  : `No task chats${filter === "waiting" ? " waiting for a reply" : ""}.`}
              </div>
            )}
            {rows.map((r) => {
              const on = open && open.kpi_id === r.kpi_id;
              return (
                <button key={r.kpi_id} type="button" onClick={() => openThread(r)} className="cardbox"
                  style={{ width: "100%", textAlign: "left", padding: 8, marginBottom: 8, gap: 2, cursor: "pointer", font: "inherit", color: "inherit", border: on ? "1px solid var(--brand)" : undefined, background: on ? "var(--lz-prog-bg)" : undefined }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {!r.is_general && <Lozenge tone="neutral" style={{ textTransform: "none" }}>{r.ref}</Lozenge>}
                    <b style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.is_general ? r.client : r.title}</b>
                    {r.waiting > 0 && <span className="side-badge">{r.waiting}</span>}
                  </div>
                  <div style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: r.waiting ? 600 : 400, color: r.waiting ? undefined : "var(--subtle)" }}>{r.last_who}: {r.last}</div>
                  <div className="mini" style={{ display: "flex" }}><span>{r.at_label}</span>{!r.is_general && <span style={{ marginLeft: 8 }}>· {r.client}</span>}<span style={{ marginLeft: "auto" }}>{r.count} msgs</span></div>
                </button>
              );
            })}
          </div>
          <div>
            {!open ? <div className="cardbox mini" style={{ textAlign: "center", padding: 24 }}>Pick a chat on the left: all its messages show here, by date and talk.</div> : (
              <div className="cardbox" style={{ padding: 0, gap: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
                  {!open.is_general && <Lozenge tone="neutral" style={{ textTransform: "none" }}>{open.ref}</Lozenge>}
                  <b>{open.is_general ? `🌐 General · ${open.client}` : open.title}</b>
                  <span className="mini">{!open.is_general && `${open.client} · `}{open.count} messages</span>
                  <button type="button" className="btn btn-ghost" style={{ marginLeft: "auto", height: 28, fontSize: 12.5 }} onClick={() => openBoard(open)}>{open.is_general ? "💬 Open chat" : "↗ Open task"}</button>
                </div>
                <div style={{ padding: 12 }}>
                  {threadLoading ? <Skeleton rows={4} /> : <TalkThread key={open.kpi_id} days={open.days || []} />}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <Modal open={!!chat} onClose={() => { setChat(null); load(); }} title={chat ? `💬 ${chat.client} · ${chat.ref}` : ""} width={640}>
        {chat && <ChatTab key={chat.kpi_id} kpiId={chat.kpi_id} taskRef={chat.ref} onSeen={load} />}
      </Modal>
    </>
  );
}

/* The chat of one task, by date, then coloured talks (Odoo KpiTalkThread). */
export function TalkThread({ days }) {
  const [openDays, setOpenDays] = useState({});
  const [photo, setPhoto] = useState(null);
  const dayCount = (day) => day.sessions.reduce((n, s) => n + s.count, 0);
  return (
    <div>
      {photo && <PhotoViewer photo={photo} onClose={() => setPhoto(null)} />}
      {days.map((day) => {
        const isOpen = !!openDays[day.date];
        const waiting = day.sessions.some((s) => s.status === "waiting");
        const n = dayCount(day);
        return (
          <div key={day.date}>
            <button type="button" aria-expanded={isOpen} onClick={() => setOpenDays((o) => ({ ...o, [day.date]: !o[day.date] }))}
              style={{ width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 8, border: "1px solid var(--border)", borderRadius: 6, background: "var(--hover)", padding: "8px 12px", marginBottom: 8, cursor: "pointer", font: "inherit", color: "inherit" }}>
              <span className="mini">{isOpen ? "▾" : "▸"}</span>
              <b>{day.label}</b>
              <span className="mini">{day.sessions.length} talk{day.sessions.length !== 1 && "s"} · {n} message{n !== 1 && "s"}</span>
              {waiting && <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 600, color: "#B42318" }}>● waiting</span>}
            </button>
            {isOpen && day.sessions.map((s, si) => {
              const c = T.colour(si);
              return (
                <div key={s.n}>
                  {s.gap_min > 0 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0", fontSize: 11, color: "#8A939E" }}>
                      <span style={{ flex: 1, borderTop: "1px dashed #C9CED4" }} />{T.gapLabel(s.gap_min)} gap<span style={{ flex: 1, borderTop: "1px dashed #C9CED4" }} />
                    </div>
                  )}
                  <div style={{ background: c.band, boxShadow: `inset 4px 0 0 ${c.bar}`, borderRadius: 6, padding: 8, marginBottom: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", fontSize: 12, fontWeight: 600, color: c.text }}>
                      <span>Talk {s.n} · {s.start}{s.end !== s.start && ` – ${s.end}`} · {s.count} message{s.count !== 1 && "s"}</span>
                      {s.status === "answered" && <span style={{ marginLeft: "auto", color: "#0F5E2D" }}>✓ answered{s.by && ` by ${s.by}`}</span>}
                      {s.status === "waiting" && <span style={{ marginLeft: "auto", color: "#B42318" }}>● waiting for the team</span>}
                    </div>
                    {s.messages.map((msg) => (
                      <div key={msg.id} style={{ alignSelf: msg.side === "team" ? "flex-end" : "flex-start", maxWidth: "75%", background: msg.side === "team" ? "#D9FDD3" : "#FFFFFF", color: "#111", borderRadius: 6, padding: "4px 8px" }}>
                        <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
                          <b style={{ color: msg.side === "team" ? "#1D4FA8" : "#B45309" }}>{msg.who}{msg.side === "client" && " · client"}</b>
                          <span style={{ marginLeft: "auto", color: "#667085" }}>{msg.time}</span>
                        </div>
                        {msg.body && <div style={{ whiteSpace: "pre-wrap" }}>{msg.body}</div>}
                        {(msg.files || []).map((f) => {
                          const url = fileUrl(f.url);
                          return (
                            <div key={f.id} style={{ margin: "4px 0" }}>
                              {f.kind === "image" ? <img src={url} alt={f.name} title={f.name} loading="lazy" onClick={() => setPhoto({ url, name: f.name, who: msg.side === "client" ? `${msg.who} · client` : msg.who, time: msg.time, body: msg.body || "" })} style={{ display: "block", maxWidth: 260, maxHeight: 260, borderRadius: 6, cursor: "zoom-in" }} />
                                : f.kind === "video" ? <video src={url} controls preload="metadata" style={{ display: "block", maxWidth: 300, maxHeight: 260, borderRadius: 6 }} />
                                : f.kind === "document" ? <a href={url} target="_blank" rel="noopener noreferrer" style={{ display: "flex", gap: 8, alignItems: "center", padding: 8, borderRadius: 6, background: "rgba(0,0,0,.05)", minWidth: 200, wordBreak: "break-all", color: "inherit", textDecoration: "none" }}><span>📄</span><b>{f.name}</b></a>
                                : <audio src={url} controls preload="metadata" style={{ display: "block", width: 260 }} />}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/* A tapped photo, over the page, as in the task chat: who and when on top,
   ⤓ open / download and ✕ close, its words under the photo. */
function PhotoViewer({ photo, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const out = (e) => { if (e.target === e.currentTarget) onClose(); };
  return (
    <div className="chat-viewer" role="dialog" aria-modal="true" aria-label={photo.name} onClick={out}>
      <div className="chat-viewer-bar">
        <span className="chat-viewer-name"><b>{photo.who || photo.name}</b>{photo.time && <small>{photo.time}</small>}</span>
        <a href={photo.url} target="_blank" rel="noreferrer" download={photo.name} title="Open / download" aria-label="Open / download">⤓</a>
        <button type="button" title="Close" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="chat-viewer-stage" onClick={out}><img src={photo.url} alt={photo.name} /></div>
      {photo.body && <div className="chat-viewer-cap">{photo.body}</div>}
    </div>
  );
}
