"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMe } from "@/lib/me";
import * as A from "@/lib/services/admin";
import { FAQ, QUICK, personQuestions, suggest } from "./aiFaq";
import { downloadSections, exportable } from "./aiExport";
import { useOutside } from "@/components/ui";

/* 369 AI Assistant on the Owner Dashboard: a slide-in drawer (the "Ask AI" pill,
   Ctrl/⌘+J to toggle, Esc to close), styled after the 369 AI Assistant preview.
   Built to be used without typing: an FAQ by topic (Today, Tasks, People,
   Performance, Find a task), a one-tap strip above the input, and suggestions
   while typing. The server reads the question, fetches the live data and
   answers with numbers, tables and task links (/kra_kpi/ai_assistant/ask);
   questions mean "today" unless they name a period ("…this week"). With no AI
   key it is all rules: nothing is made up and no data leaves the server. Every
   chat is saved (kpi.ai.chat) and listed under History.
   variant="panel": docked on the Dashboard page (Dashboard.jsx), always open,
   no launcher or close; Ctrl/⌘+J puts the cursor in the box. Same chat as the
   drawer. `onAnswer(res, question)` hears every answer (to highlight a card). */
const KEY = "kpi.assistant.chat";
const SOURCE = { rules: "Data answer", "ai-gemini": "Gemini", "ai-groq": "Groq", "ai-claude": "Claude" };
const P = { chart: "M7 17v-4M12 17V8M17 17v-6", spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  send: "M12 19V5M6 11l6-6 6 6", plus: "M12 5v14M5 12h14", x: "M18 6 6 18M6 6l12 12",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2", back: "M15 18l-6-6 6-6",
  download: "M12 3v12M7 10l5 5 5-5M5 21h14", pdf: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3", faq: "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3", user: "M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z" };

const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch (_) { return null; } };
const save = (v) => { try { sessionStorage.setItem(KEY, JSON.stringify(v)); } catch (_) {} };
const fmtDay = (d) => { if (!d) return ""; const x = new Date(`${d}T00:00:00`); return isNaN(x) ? d : x.toLocaleDateString("en-IN", { day: "numeric", month: "short" }); };
const fmtRange = (r) => (!r ? "" : r.start === r.end ? fmtDay(r.start) : `${fmtDay(r.start)} – ${fmtDay(r.end)}`);
const fmtWhen = (s) => {
  if (!s) return "";
  const d = new Date(String(s).replace(" ", "T") + (String(s).endsWith("Z") ? "" : "Z"));
  if (isNaN(d)) return s;
  const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
  const time = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  if (d.toDateString() === y.toDateString()) return `Yesterday, ${time}`;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" }) + `, ${time}`;
};

const Svg = ({ d, className = "ai-ic" }) => <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d={d} /></svg>;
const Orb = ({ small }) => <span className={`ai-orb ${small ? "sm" : ""}`} aria-hidden="true"><svg viewBox="0 0 24 24"><path d={P.chart} /></svg></span>;

export default function AiAssistant({ open: openProp, onOpenChange, variant = "drawer", onAnswer }) {
  const { me } = useMe();
  const docked = variant === "panel";
  const [openSelf, setOpenSelf] = useState(false);
  const open = docked || (openProp ?? openSelf);
  const setOpen = useCallback((v) => (onOpenChange ? onOpenChange(v) : setOpenSelf(v)), [onOpenChange]);
  const [msgs, setMsgs] = useState([]); /* {role:"user",text} | {role:"bot",res} | {role:"err",text,q} | {role:"note",text} */
  const [ctx, setCtx] = useState({});
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const seq = useRef(0); /* bumps on Stop / New chat: a late answer to an older question is dropped */
  const bodyRef = useRef(null);
  const inputRef = useRef(null);
  const [chatId, setChatId] = useState(null);
  const [view, setView] = useState("chat"); /* chat | faq | history */
  const [chats, setChats] = useState(null);
  const [histErr, setHistErr] = useState("");
  const [people, setPeople] = useState([]);
  const [hi, setHi] = useState(-1); /* highlighted type-ahead suggestion */

  useEffect(() => {
    const s = load();
    if (!s) return;
    setMsgs(s.msgs || []); setCtx(s.ctx || {}); setChatId(s.chatId || null);
    /* The tab's copy shows at once; the saved chat on the server is the truth. */
    if (s.chatId) A.getAssistantChat(s.chatId).then((c) => { setMsgs(c.messages || []); setCtx(c.context || {}); }).catch(() => setChatId(null));
  }, []);
  useEffect(() => { save({ msgs: msgs.slice(-30), ctx, chatId }); }, [msgs, ctx, chatId]);
  useEffect(() => { if (open && !people.length) A.getIntakeUsers().then((u) => setPeople(u || [])).catch(() => {}); }, [open, people.length]);
  useEffect(() => { const el = bodyRef.current; if (el && view === "chat") el.scrollTop = el.scrollHeight; }, [msgs, busy, open, view]);
  useEffect(() => { if (open && !docked) { const t = setTimeout(() => inputRef.current?.focus(), 250); return () => clearTimeout(t); } }, [open, docked]);
  /* Sit 12px under the app's top bar, wherever it ends (the desktop-alerts bar
     above it pushes it down). */
  const [top, setTop] = useState(null);
  useEffect(() => {
    if (!open || docked) return;
    const place = () => { const bar = document.querySelector(".k-app .top"); const b = bar ? bar.getBoundingClientRect().bottom : 56; setTop(Math.max(8, Math.round(b) + 12)); };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, docked]);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") { e.preventDefault(); if (docked) inputRef.current?.focus(); else setOpen(!open); }
      else if (e.key === "Escape" && open && !docked) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen, docked]);

  const typeAhead = useMemo(() => (q.trim().length >= 2 && !busy ? suggest(q, people, 5) : []), [q, people, busy]);
  useEffect(() => setHi(-1), [q]);

  const ask = async (text) => {
    const question = String(text ?? q).trim();
    if (!question || busy) return;
    const mine = ++seq.current;
    setQ(""); setView("chat");
    setMsgs((m) => [...m, { role: "user", text: question }]);
    setBusy(true);
    try {
      const r = A.assertOk(await A.askAssistant({ question, period: "today", context: ctx, chatId }), "The assistant couldn't answer that.");
      if (mine !== seq.current) return;
      setMsgs((m) => [...m, { role: "bot", res: r, q: question, ctxIn: ctx }]); /* q + ctxIn: to rebuild it in full for a download */
      setCtx(r.context || {});
      if (r.chat_id) { setChatId(r.chat_id); setChats(null); }
      onAnswer?.(r, question);
    } catch (e) {
      if (mine === seq.current) setMsgs((m) => [...m, { role: "err", text: e.message || "Something went wrong.", q: question }]);
    } finally { if (mine === seq.current) setBusy(false); }
  };
  /* An FAQ item: ask it, or ("fill") put its start in the input to finish. */
  const pick = (item) => {
    if (typeof item === "string") return ask(item);
    setView("chat"); setQ(item.fill);
    setTimeout(() => { const el = inputRef.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 50);
  };
  const stop = () => { seq.current++; setBusy(false); setMsgs((m) => [...m, { role: "note", text: "Stopped." }]); };
  const newChat = () => { seq.current++; setBusy(false); setMsgs([]); setCtx({}); setQ(""); setChatId(null); setView("chat"); inputRef.current?.focus(); };
  const showHistory = async () => {
    if (view === "history") { setView("chat"); return; }
    setView("history"); setHistErr("");
    try { setChats(await A.listAssistantChats()); } catch (e) { setHistErr(e.message); }
  };
  const openChat = async (id) => {
    seq.current++; setBusy(false); setHistErr("");
    try {
      const c = await A.getAssistantChat(id);
      setMsgs(c.messages || []); setCtx(c.context || {}); setChatId(c.id); setView("chat");
    } catch (e) { setHistErr(e.message); }
  };
  const removeChat = async (id) => {
    try {
      await A.deleteAssistantChat(id);
      setChats((l) => (l || []).filter((c) => c.id !== id));
      if (id === chatId) { setMsgs([]); setCtx({}); setChatId(null); }
    } catch (e) { setHistErr(e.message); }
  };
  const onKeyDown = (e) => {
    if (typeAhead.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setHi((i) => (e.key === "ArrowDown" ? (i + 1) % typeAhead.length : (i <= 0 ? typeAhead.length - 1 : i - 1)));
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask(hi >= 0 && typeAhead[hi] ? typeAhead[hi] : undefined);
    }
  };
  /* Downloads: an answer whose tables were cut at 50 rows is fetched again in
     full (not saved to the chat) before the PDF / Word file is built. */
  const fullSection = async (i) => {
    const m = msgs[i];
    const question = m.q || (msgs[i - 1]?.role === "user" ? msgs[i - 1].text : "");
    const cut = (m.res?.blocks || []).some((b) => b.type === "table" && b.more > 0);
    const res = cut && question ? await A.exportAssistantAnswer({ question, period: m.res.period || "today", context: m.ctxIn || {} }) : m.res;
    return { question, res };
  };
  const downloadOne = async (kind, i) => {
    const s = await fullSection(i);
    await downloadSections(kind, [s], { user: me?.name, subtitle: "Answer", name: s.res?.title });
  };
  const botIdx = msgs.map((m, i) => (m.role === "bot" && exportable(m.res) ? i : -1)).filter((i) => i >= 0);
  const downloadAll = async (kind) => {
    const sections = [];
    for (const i of botIdx) sections.push(await fullSection(i));
    await downloadSections(kind, sections, {
      user: me?.name, subtitle: `Chat - ${sections.length} answer${sections.length === 1 ? "" : "s"}`,
      name: `chat-${sections[0]?.question || "assistant"}`,
    });
  };
  const lastAi = [...msgs].reverse().find((m) => m.role === "bot")?.res?.ai;
  const initial = (me?.name || "?").trim().charAt(0).toUpperCase();
  const firstName = (me?.name || "").trim().split(" ")[0];

  return (
    <>
      {!open && (
        <button type="button" className="ai-launcher" onClick={() => setOpen(true)} aria-label="Open AI assistant (Ctrl+J)" title="Ask AI (Ctrl+J)">
          <Orb small /> <span>Ask AI</span>
        </button>
      )}
      {!docked && <div className={`ai-scrim ${open ? "open" : ""}`} onClick={() => setOpen(false)} />}
      <aside className={`ai-drawer ${docked ? "ai-panel" : ""} ${open ? "open" : ""}`} style={top != null && !docked ? { top } : undefined} aria-label="369 AI Assistant" aria-hidden={!open} inert={!open}>
        <header className="ai-head">
          <Orb small />
          <div className="ai-headtxt">
            <strong>369 AI Assistant</strong>
            <span><i className="ai-live" /> {lastAi ? "AI on · reading your dashboard" : "Reading your dashboard · live data"}</span>
          </div>
          <button type="button" className={`ai-iconbtn ${view === "faq" ? "on" : ""}`} onClick={() => setView(view === "faq" ? "chat" : "faq")} title="Questions you can ask" aria-label="Questions you can ask" aria-pressed={view === "faq"}><Svg d={P.faq} /></button>
          {botIdx.length > 0 && view === "chat" && (
            <DownloadMenu onPick={downloadAll} label="Download whole chat" icon title="Download whole chat (PDF / Word)" />
          )}
          <button type="button" className={`ai-iconbtn ${view === "history" ? "on" : ""}`} onClick={showHistory} title="Chat history" aria-label="Chat history" aria-pressed={view === "history"}><Svg d={P.history} /></button>
          <button type="button" className="ai-iconbtn" onClick={newChat} title="New chat" aria-label="New chat"><Svg d={P.plus} /></button>
          {!docked && <button type="button" className="ai-iconbtn" onClick={() => setOpen(false)} title="Close (Esc)" aria-label="Close"><Svg d={P.x} /></button>}
        </header>

        {view === "history" ? (
          <div className="ai-body ai-history">
            <div className="ai-histhead">
              <button type="button" className="ai-chip sm" onClick={() => setView("chat")}><Svg d={P.back} /> Back to chat</button>
              <span className="ai-meta">{chats ? `${chats.length} saved chat${chats.length === 1 ? "" : "s"}` : ""}</span>
            </div>
            {histErr && <p className="ai-meta ai-err">{histErr}</p>}
            {!chats && !histErr && <span className="ai-dots" aria-label="Loading"><i /><i /><i /></span>}
            {chats && !chats.length && <p className="ai-meta">No saved chats yet. Every question you ask is saved here.</p>}
            {(chats || []).map((c) => (
              <div key={c.id} className={`ai-histrow ${c.id === chatId ? "on" : ""}`}>
                <button type="button" className="ai-histopen" onClick={() => openChat(c.id)}>
                  <b>{c.title}</b>
                  <small>{fmtWhen(c.updated)} · {Math.ceil((c.count || 0) / 2)} question{Math.ceil((c.count || 0) / 2) === 1 ? "" : "s"}{c.id === chatId ? " · open now" : ""}</small>
                </button>
                <button type="button" className="ai-iconbtn sm" onClick={() => removeChat(c.id)} title="Delete this chat" aria-label={`Delete chat: ${c.title}`}><Svg d={P.trash} /></button>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="ai-body" ref={bodyRef} aria-live="polite">
              {view === "faq" ? (
                <div className="ai-faqview">
                  <div className="ai-histhead">
                    <button type="button" className="ai-chip sm" onClick={() => setView("chat")}><Svg d={P.back} /> Back to chat</button>
                    <span className="ai-meta">Tap a question to ask it</span>
                  </div>
                  <Faq people={people} onPick={pick} />
                </div>
              ) : !msgs.length ? (
                <div className="ai-welcome">
                  <Orb />
                  <h3>{firstName ? `Hi ${firstName}, how can I help?` : "How can I help today?"}</h3>
                  <p>Tap a question, or type your own. Add "this week" or "this month" for other periods.</p>
                  <Faq people={people} onPick={pick} />
                </div>
              ) : msgs.map((m, i) => m.role === "user" ? (
                <div key={i} className="ai-user"><div className="ai-bubble">{m.text}</div><span className="ai-avatar">{initial}</span></div>
              ) : (
                <div key={i} className="ai-ai">
                  <Orb small />
                  <div className={`ai-text ${m.role === "err" ? "err" : ""}`}>
                    {m.role === "bot" ? <Answer res={m.res} onAsk={ask} busy={busy} last={i === msgs.length - 1} onDownload={exportable(m.res) ? (kind) => downloadOne(kind, i) : null} />
                      : m.role === "err" ? <><p>{m.text}</p><button type="button" className="ai-chip sm" onClick={() => ask(m.q)} disabled={busy}>Try again</button></>
                      : <p className="ai-meta">{m.text}</p>}
                  </div>
                </div>
              ))}
              {busy && view === "chat" && <div className="ai-ai"><Orb small /><div className="ai-text"><span className="ai-dots" aria-label="Looking it up"><i /><i /><i /></span></div></div>}
            </div>

            {msgs.length > 0 && view === "chat" && !typeAhead.length && (
              <div className="ai-quick" aria-label="Quick questions">
                <button type="button" className="ai-qchip faq" onClick={() => setView("faq")}><Svg d={P.faq} /> All questions</button>
                {QUICK.map(([label, question]) => <button key={label} type="button" className="ai-qchip" disabled={busy} onClick={() => ask(question)} title={question}>{label}</button>)}
              </div>
            )}

            <div className="ai-composer-wrap">
              {typeAhead.length > 0 && (
                <ul className="ai-suggest" role="listbox" aria-label="Suggested questions">
                  {typeAhead.map((s, i) => (
                    <li key={s} role="option" aria-selected={i === hi}>
                      <button type="button" className={i === hi ? "on" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => ask(s)}><Svg d={P.spark} /> {s}</button>
                    </li>
                  ))}
                </ul>
              )}
              <form className="ai-composer" onSubmit={(e) => { e.preventDefault(); ask(); }}>
                <textarea ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} rows={1} maxLength={1000} placeholder="Ask anything about your team's work…" aria-label="Ask the assistant" onKeyDown={onKeyDown} />
                {busy
                  ? <button type="button" className="ai-send stop" onClick={stop} aria-label="Stop"><span /></button>
                  : <button type="submit" className="ai-send" disabled={!q.trim()} aria-label="Send"><Svg d={P.send} /></button>}
              </form>
            </div>
          </>
        )}
      </aside>
    </>
  );
}

/* The FAQ: topic tabs, then that topic's questions. People lists the team;
   picking someone shows the questions about them. */
function Faq({ people, onPick }) {
  const [tab, setTab] = useState("today");
  const [person, setPerson] = useState(null);
  const [find, setFind] = useState("");
  const sec = FAQ.find((s) => s.key === tab) || FAQ[0];
  const shown = people.filter((p) => !find.trim() || (p.name || "").toLowerCase().includes(find.trim().toLowerCase()));
  return (
    <div className="ai-faq">
      <div className="ai-tabs" role="tablist">
        {FAQ.map((s) => <button key={s.key} type="button" role="tab" aria-selected={tab === s.key} className={tab === s.key ? "on" : ""} onClick={() => { setTab(s.key); setPerson(null); }}>{s.label}</button>)}
      </div>
      {sec.find ? <FindTasks onPick={onPick} /> : sec.people ? (
        person ? (
          <div className="ai-chips">
            <button type="button" className="ai-chip sm back" onClick={() => setPerson(null)}><Svg d={P.back} /> All people</button>
            {personQuestions(person).map((qq) => <button key={qq} type="button" className="ai-chip" onClick={() => onPick(qq)}><Svg d={P.spark} /> {qq}</button>)}
          </div>
        ) : (
          <>
            <label className="ai-find"><Svg d={P.search} /><input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a person" aria-label="Find a person" /></label>
            <div className="ai-people">
              {!people.length && <p className="ai-meta">Loading the team…</p>}
              {shown.map((p) => <button key={p.id} type="button" className="ai-person-chip" onClick={() => setPerson(p.name)}><Svg d={P.user} /> {p.name}</button>)}
              {people.length > 0 && !shown.length && <p className="ai-meta">Nobody matches "{find}".</p>}
            </div>
          </>
        )
      ) : (
        <div className="ai-chips">
          {sec.items.map((it) => {
            const label = typeof it === "string" ? it : it.label;
            return <button key={label} type="button" className={`ai-chip ${typeof it === "string" ? "" : "fill"}`} onClick={() => onPick(it)}><Svg d={typeof it === "string" ? P.spark : P.search} /> {label}</button>;
          })}
        </div>
      )}
    </div>
  );
}

/* Live task search: matches show as you type (recently updated tasks before
   anything is typed); one tap asks for that task's status. */
const STATE_LABEL = { in_progress: "Running", paused: "Paused", partially_completed: "Pending approval", completed: "Completed",
  awaiting_client: "Awaiting client sign-off", queue_waiting: "Queued", pre_approval_pending: "Waiting for client approval",
  pre_approval_approved: "Client approved, not started", pre_approval_partial: "Partly approved by client", hold: "On hold", rework: "Rework needed" };
function FindTasks({ onPick }) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      A.findAssistantTasks(text.trim()).then((r) => { if (live) { setRows(r); setErr(""); } }).catch((e) => { if (live) setErr(e.message); });
    }, text.trim() ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [text]);
  return (
    <>
      <label className="ai-find"><Svg d={P.search} /><input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a task name or number, e.g. REQ-146" aria-label="Find a task" autoFocus /></label>
      <p className="ai-meta" style={{ margin: "0 2px" }}>{text.trim() ? "Tap a task to see its status" : "Recently updated: tap one to see its status"}</p>
      <div className="ai-chips">
        {err && <p className="ai-meta ai-err">{err}</p>}
        {!rows && !err && <span className="ai-dots" aria-label="Searching"><i /><i /><i /></span>}
        {rows && !rows.length && <p className="ai-meta">No task matches "{text}". Try another word or the task number.</p>}
        {(rows || []).map((t) => (
          <button key={t.id} type="button" className="ai-chip ai-taskhit" onClick={() => onPick(`Status of ${t.ref || `"${t.name}"`}`)}>
            <Svg d={P.search} />
            <span><b>{t.ref ? `${t.ref} · ` : ""}{t.name}</b><small>{t.person} · {STATE_LABEL[t.status] || "Not started"}</small></span>
          </button>
        ))}
      </div>
    </>
  );
}

/* "Download" → PDF / Word menu. `onPick(kind)` returns a promise; the menu shows
   "Preparing…" while it runs and the error if it fails. `icon` = header button. */
function DownloadMenu({ onPick, label = "Download", icon, title }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const ref = useOutside(useCallback(() => setOpen(false), []));
  const go = async (kind) => {
    setBusy(kind); setErr("");
    try { await onPick(kind); setOpen(false); } catch (e) { setErr(e.message || "Download failed."); } finally { setBusy(""); }
  };
  return (
    <span className={`ai-dlwrap ${icon ? "head" : ""}`} ref={ref}>
      {icon
        ? <button type="button" className={`ai-iconbtn ${open ? "on" : ""}`} onClick={() => setOpen((o) => !o)} title={title || label} aria-label={label} aria-expanded={open}><Svg d={P.download} /></button>
        : <button type="button" className="ai-dl" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={title || label}><Svg d={P.download} /> {label}</button>}
      {open && (
        <span className="ai-dlmenu" role="menu">
          {icon && <small className="ai-dlhead">{label}</small>}
          <button type="button" role="menuitem" disabled={!!busy} onClick={() => go("pdf")}><Svg d={P.pdf} /> {busy === "pdf" ? "Preparing…" : "PDF"}</button>
          <button type="button" role="menuitem" disabled={!!busy} onClick={() => go("docx")}><Svg d={P.pdf} /> {busy === "docx" ? "Preparing…" : "Word (.docx)"}</button>
          {err && <small className="ai-err">{err}</small>}
        </span>
      )}
    </span>
  );
}

function Answer({ res, onAsk, busy, last, onDownload }) {
  const chat = res.intent === "smalltalk";
  return (
    <>
      {res.title && <p><strong>{res.title}</strong></p>}
      {(res.blocks || []).map((b, i) => <Block key={i} b={b} onAsk={onAsk} busy={busy} />)}
      {!chat && (
        <div className="ai-metarow">
          <p className="ai-meta">{SOURCE[res.source] || res.source}{res.date_range ? ` · ${fmtRange(res.date_range)}` : ""}</p>
          {onDownload && <DownloadMenu onPick={onDownload} />}
        </div>
      )}
      {last && res.suggestions?.length > 0 && (
        <div className="ai-chips row">{res.suggestions.map((s) => <button key={s} type="button" className="ai-chip sm" disabled={busy} onClick={() => onAsk(s)}><Svg d={P.spark} /> {s}</button>)}</div>
      )}
    </>
  );
}

function Block({ b, onAsk, busy }) {
  if (b.type === "stats") {
    return <div className="ai-stats">{(b.items || []).map((it) => <div key={it.label} className="ai-stat"><b>{it.value}</b><small>{it.label}</small></div>)}</div>;
  }
  if (b.type === "list") {
    return <>{b.title && <p className="ai-sub">{b.title}</p>}<ul>{(b.items || []).map((t, i) => <li key={i}>{t}</li>)}</ul></>;
  }
  if (b.type === "table") {
    const cols = b.columns || [];
    return (
      <div className="ai-table">
        <div className="table-scroll">
          <table className="table">
            <thead><tr>{cols.map((c) => <th key={c.key} className={c.kind === "num" ? "num" : undefined}>{c.label}</th>)}</tr></thead>
            <tbody>
              {(b.rows || []).map((r, i) => (
                <tr key={r.task_id || `${r.person}-${i}`}>
                  {cols.map((c) => (
                    <td key={c.key} className={c.kind === "num" ? "num" : c.kind === "task" || c.key === "paused" ? "wrap" : undefined}>
                      {c.kind === "task" && r.task_id ? <Link href={`/browse/${r.task_id}`}>{r[c.key]}</Link>
                        : c.kind === "person" && r[c.key] && r[c.key] !== "Unassigned" ? <button type="button" className="ai-person" disabled={busy} title={`Ask about ${r[c.key]}`} onClick={() => onAsk(`How is ${r[c.key]} doing?`)}>{r[c.key]}</button>
                        : (r[c.key] === "" || r[c.key] == null ? "—" : r[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {b.more > 0 && <p className="ai-meta">+{b.more} more not shown. Narrow it down, e.g. by person or priority.</p>}
      </div>
    );
  }
  return <p>{b.text}</p>;
}
