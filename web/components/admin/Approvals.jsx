"use client";
/* Approvals: everything waiting on a manager, as Odoo's KRA / KPI › Approvals
   (kpi.approval, views/kpi_approval_views.xml), plus developers' questions to
   the manager (kpi.doubt).

   The rule this desk serves: no developer talks to a client and no client
   talks to a developer; the manager is the only bridge. Every decision is the
   module's own (kpi.approval.decide / the kpi.doubt actions); this screen only
   collects what that decision needs. A decision may end with a WhatsApp post
   that fails when no WhatsApp server is reachable. The decision still stands,
   so success here is the decision, never "sent on WhatsApp". */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Empty, ErrorState, Field, Icon, Input, Lozenge, Modal, PageHeader, Select, Skeleton, useDialogs, useFlags } from "@/components/ui";
import { getIntakeUsers } from "@/lib/services/admin";
import { local, m2o } from "@/lib/services/sysadmin";
import * as P from "@/lib/services/approvals";

const when = (ts) => local(ts, { date: true });
const FIELD = { border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" };
const TA = { ...FIELD, resize: "vertical" };
/* <input type="datetime-local"> is local time; Odoo wants UTC "YYYY-MM-DD HH:MM:SS". */
const toUtc = (v) => { if (!v) return false; const d = new Date(v); return isNaN(d) ? false : d.toISOString().slice(0, 19).replace("T", " "); };

export default function Approvals() {
  const flags = useFlags();
  const dlg = useDialogs();
  const [tab, setTab] = useState("all");
  const [rows, setRows] = useState(null);
  const [counts, setCounts] = useState({});
  const [cover, setCover] = useState(null);
  const [doubts, setDoubts] = useState(null);
  const [allDoubts, setAllDoubts] = useState(false);
  const [openDoubts, setOpenDoubts] = useState(0);
  const [err, setErr] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [decide, setDecide] = useState(null);   /* { row, decision, context, title } */
  const [reply, setReply] = useState(null);     /* { doubt, mode: answer|release|reject } */

  const load = useCallback(async () => {
    try {
      /* The coverage warning comes worded by Odoo (kra.master.manager_coverage_message),
         the same text its own Approvals menu shows. */
      const [r, c, cov, nOpen] = await Promise.all([P.listApprovals(), P.waitingCounts(), P.coverageMessage().catch(() => ""), P.countOpenDoubts().catch(() => 0)]);
      setRows(r || []); setCounts(c || {}); setCover(cov || ""); setOpenDoubts(nOpen || 0); setErr(null);
    } catch (e) { setErr(e); }
  }, []);
  const loadDoubts = useCallback(async () => {
    try { setDoubts(await P.listDoubts(allDoubts ? [] : ["open", "answered"])); } catch (e) { flags.err(e.message); setDoubts([]); }
  }, [allDoubts]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (tab === "questions") loadDoubts(); }, [tab, loadDoubts]);
  const refresh = () => { load(); if (tab === "questions") loadDoubts(); window.dispatchEvent(new CustomEvent("kpi:approvals")); };

  const shown = useMemo(() => (tab === "all" ? rows || [] : (rows || []).filter((r) => r.kind === tab)), [rows, tab]);

  /* Approve / Refuse: a decision that needs nothing more is done at once;
     anything else opens the dialog with what the module asks for. */
  const act = async (row, decision) => {
    setBusyId(`${row.id}:${decision}`);
    try {
      const res = decision === "approve" ? await P.approve(row) : await P.reject(row);
      if (res.done) { flags.ok(`Done — ${res.message}`); refresh(); }
      else setDecide({ row, decision, context: res.context, title: res.title || (decision === "approve" ? row.approve_label : row.reject_label) });
    } catch (e) { flags.err(e.message); } finally { setBusyId(null); }
  };

  const tabs = [
    { key: "all", label: "All", count: counts.total || 0 },
    ...P.KINDS.map((k) => ({ key: k.key, label: k.tab, count: counts[k.key] || 0 })),
    { key: "questions", label: "Questions", count: openDoubts },
  ];
  const noManager = typeof cover === "string" && cover.trim().length > 0;

  return (
    <>
      <PageHeader crumbs={[{ label: "Clients" }, { label: "Approvals" }]} title="Approvals" meta="Everything waiting on a manager. No developer talks to a client — you are the bridge.">
        {rows && <span className="chip">{counts.total || 0} waiting</span>}
        <Button size="sm" kind="ghost" icon="swap" onClick={refresh}>Refresh</Button>
      </PageHeader>
      <div className="page">
        {noManager && (
          <div className="callout" style={{ background: "var(--lz-paused-bg)", borderColor: "var(--pri-important)", color: "var(--lz-paused)", alignItems: "flex-start" }}>
            <Icon n="warn" size={18} />
            <span style={{ flex: 1 }}>
              {cover}{" "}
              <a href="/settings/kra-tree" style={{ color: "inherit", fontWeight: 700 }}>Set managers in Settings › KRA tree</a> · <a href="/settings/login" style={{ color: "inherit", fontWeight: 700 }}>Login management</a>.
            </span>
          </div>
        )}
        <div className="tabs" style={{ marginBottom: 12, flexWrap: "wrap" }}>
          {tabs.map((t) => <span key={t.key} className={tab === t.key ? "on" : ""} onClick={() => setTab(t.key)} style={{ cursor: "pointer" }}>{t.label}{t.count ? <em>{t.count}</em> : null}</span>)}
        </div>
        {err && !rows && <ErrorState error={err} onRetry={load} />}
        {tab === "questions"
          ? <Questions doubts={doubts} all={allDoubts} setAll={setAllDoubts} onReply={setReply} onMeeting={async (d) => {
              if (!(await dlg.confirm({ title: "Make a meeting?", text: d.kind === "meet_admin" ? "An internal meeting with the developer is set up and opened now." : "A client meeting is requested. It then waits here under Meetings for you to confirm a time.", confirmLabel: "Make the meeting" }))) return;
              try { await P.meetingFromDoubt(d.id); flags.ok("Meeting made. See My Work › Meetings."); loadDoubts(); load(); } catch (e) { flags.err(e.message); }
            }} />
          : (
            <div className="cardbox table-scroll" style={{ padding: 0 }}>
              {!rows ? <div style={{ padding: 16 }}><Skeleton rows={5} /></div> : !shown.length ? <Empty icon="check" title="Nothing is waiting on you." text="New requests, databases, switch-offs, go-lives, meetings and finished work land here." /> : (
                <table className="table">
                  <thead><tr><th>Ref</th><th>What is waiting</th><th style={{ width: "28%" }}>About</th><th>Client</th><th>Asked by</th><th>Asked on</th><th className="num">Days</th><th></th></tr></thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.id}>
                        <td>{r.reference ? <span className="ref">{r.reference}</span> : <span className="mini">—</span>}</td>
                        <td><Lozenge tone={r.kind === "qa" ? "review" : r.kind === "disconnect" ? "danger" : r.kind === "meeting" ? "progress" : "todo"} style={{ textTransform: "none" }}>{P.kindLabel(r.kind)}</Lozenge></td>
                        <td><b style={{ overflowWrap: "anywhere" }}>{r.name}</b>{r.detail && <div className="mini" style={{ overflowWrap: "anywhere" }}>{r.detail}</div>}</td>
                        <td className="mini">{m2o(r.client_kra_id) || "—"}</td>
                        <td className="mini">{r.requested_by || "—"}</td>
                        <td className="mini">{when(r.requested_on)}</td>
                        <td className="num" style={{ color: r.waiting_days >= 7 ? "var(--danger)" : undefined, fontWeight: r.waiting_days >= 7 ? 800 : undefined }}>{r.waiting_days ?? ""}</td>
                        <td>
                          <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                            <Button size="sm" kind="ok" icon="check" title={r.approve_label} busy={busyId === `${r.id}:approve`} onClick={() => act(r, "approve")}>Approve</Button>
                            <Button size="sm" kind="danger" icon="x" title={r.reject_label} busy={busyId === `${r.id}:reject`} onClick={() => act(r, "reject")}>Refuse</Button>
                            {r.res_model === "kra.kpi" && <a className="btn btn-ghost" style={{ height: 28, fontSize: 12.5 }} href={`/browse/${r.res_id}`}>Open</a>}
                            {r.res_model === "kpi.meeting" && <a className="btn btn-ghost" style={{ height: 28, fontSize: 12.5 }} href="/meetings">Open</a>}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
      </div>
      {decide && <DecideDialog d={decide} onClose={() => setDecide(null)} onDone={(msg) => { flags.ok(`Done — ${msg}`); setDecide(null); refresh(); }} />}
      {reply && <ReplyDialog r={reply} onClose={() => setReply(null)} onDone={(msg) => { flags.ok(msg); setReply(null); loadDoubts(); load(); window.dispatchEvent(new CustomEvent("kpi:approvals")); }} />}
    </>
  );
}

/* The decide dialog: only the fields this decision needs, as the Odoo form
   shows them (kpi_approval_views.xml). The headline is the module's own
   wording, so nobody approves one kind thinking it is another. */
function DecideDialog({ d, onClose, onDone }) {
  const { row, decision, context, title } = d;
  const k = row.kind;
  const approve = decision === "approve";
  const needDev = approve && (k === "new_request" || k === "new_database");
  const needWhen = approve && k === "meeting";
  const needReason = !approve || k === "disconnect";
  const noteRequired = needReason && (k === "db_live" || k === "qa" || k === "disconnect");
  const showReasonPick = needReason && k !== "db_live" && k !== "qa";
  const showTell = k !== "db_live" && (!approve || k === "disconnect");
  const [users, setUsers] = useState([]);
  const [reasons, setReasons] = useState([]);
  const [f, setF] = useState({ user_id: "", scheduled_start: "", organizer_id: "", reason_id: "", note: "", tell_client: true });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (needDev || needWhen) getIntakeUsers().then(setUsers).catch(() => {});
    if (showReasonPick) P.declineReasons().then(setReasons).catch(() => setReasons([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (key, v) => { setF((x) => ({ ...x, [key]: v })); setErr(""); };
  const submit = async () => {
    if (needDev && !f.user_id) return setErr("Pick the developer to give it to.");
    if (needWhen && (!f.scheduled_start || !f.organizer_id)) return setErr("Set the time and who runs the meeting.");
    if (noteRequired && !f.note.trim()) return setErr("Say why, in your own words.");
    if (needReason && !noteRequired && !f.reason_id && !f.note.trim()) return setErr("Pick a reason or write one.");
    setBusy(true);
    try {
      const vals = {
        res_model: row.res_model, res_id: row.res_id, kind: k, decision,
        user_id: needDev ? Number(f.user_id) : false,
        scheduled_start: needWhen ? toUtc(f.scheduled_start) : false,
        organizer_id: needWhen ? Number(f.organizer_id) : false,
        reason_id: showReasonPick && f.reason_id ? Number(f.reason_id) : false,
        note: needReason ? f.note.trim() || false : false,
        tell_client: showTell ? !!f.tell_client : false,
      };
      onDone(await P.decide(vals, context));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={title || (approve ? row.approve_label : row.reject_label)} width={520}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind={approve ? "ok" : "danger"} busy={busy} onClick={submit}>Confirm</Button></>}>
      <div className="callout" style={{ margin: 0, alignItems: "flex-start" }}><Icon n="info" size={16} /><span><b>{P.kindLabel(k)}</b> — {row.reference ? `${row.reference} · ` : ""}{row.name}{row.detail ? <span className="mini" style={{ display: "block" }}>{row.detail}</span> : null}</span></div>
      {needDev && (
        <Field label="Give it to" required><span className="input"><Select value={f.user_id} onChange={(e) => set("user_id", e.target.value)} style={FIELD} placeholder="Choose a developer"><option value="">Choose a developer</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></span></Field>
      )}
      {needWhen && (
        <>
          {row.detail && <p className="mini" style={{ margin: 0 }}>The client asked for: <b>{row.detail}</b></p>}
          <div className="grid2">
            <Field label="Start" required><Input type="datetime-local" value={f.scheduled_start} onChange={(e) => set("scheduled_start", e.target.value)} /></Field>
            <Field label="Who runs it" required><span className="input"><Select value={f.organizer_id} onChange={(e) => set("organizer_id", e.target.value)} style={FIELD} placeholder="Choose"><option value="">Choose</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></span></Field>
          </div>
        </>
      )}
      {showReasonPick && (
        <Field label="Reason"><span className="input"><Select value={f.reason_id} onChange={(e) => set("reason_id", e.target.value)} style={FIELD} placeholder="Pick a reason (optional)"><option value="">Pick a reason (optional)</option>{reasons.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></span></Field>
      )}
      {needReason && (
        <Field label="In your own words" required={noteRequired} hint={showTell ? "The client reads this. Write it for them." : undefined}>
          <span className="input ta" style={{ height: "auto" }}><textarea rows={3} value={f.note} onChange={(e) => set("note", e.target.value)} placeholder={showTell ? "The client reads this. Write it for them." : "Why?"} style={TA} /></span>
        </Field>
      )}
      {showTell && (
        <label className="chk"><input type="checkbox" checked={f.tell_client} onChange={(e) => set("tell_client", e.target.checked)} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} />Tell the client</label>
      )}
      {err && <small className="err" style={{ color: "var(--danger)", fontWeight: 700 }}>{err}</small>}
    </Modal>
  );
}

/* Developers' questions to the manager. Answer goes back to the developer;
   Send to client is the ONLY path that reaches a client. */
function Questions({ doubts, all, setAll, onReply, onMeeting }) {
  return (
    <>
      <div className="toolbar"><label className="row mini" style={{ cursor: "pointer" }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show answered, sent and closed too</label></div>
      <div className="cardbox table-scroll" style={{ padding: 0 }}>
        {!doubts ? <div style={{ padding: 16 }}><Skeleton rows={4} /></div> : !doubts.length ? <Empty icon="check" title="No questions waiting." text="When a developer asks the manager something from a task, it shows here." /> : (
          <table className="table">
            <thead><tr><th>Task</th><th>Kind</th><th style={{ width: "34%" }}>Question</th><th>Asked by</th><th>Asked on</th><th>State</th><th></th></tr></thead>
            <tbody>
              {doubts.map((d) => {
                const [tone, label] = P.DOUBT_STATES[d.state] || ["neutral", d.state];
                const live = d.state === "open" || d.state === "answered";
                return (
                  <tr key={d.id}>
                    <td>{d.task_ref ? <span className="ref">{d.task_ref}</span> : null}<div className="mini">{m2o(d.kpi_id)}</div></td>
                    <td className="mini">{P.doubtKindLabel(d.kind)}</td>
                    <td><span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{d.question}</span>
                      {d.answer && <div className="mini" style={{ marginTop: 4, color: "var(--pri-regular)" }}><b>Answer:</b> {d.answer}</div>}</td>
                    <td className="mini">{m2o(d.raised_by_id) || "—"}</td>
                    <td className="mini">{when(d.create_date)}</td>
                    <td><Lozenge tone={tone} style={{ textTransform: "none" }}>{label}</Lozenge></td>
                    <td>
                      {live && (
                        <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                          {d.state === "open" && <Button size="sm" kind="primary" onClick={() => onReply({ doubt: d, mode: "answer" })}>Answer</Button>}
                          {!d.client_posted_at && <Button size="sm" kind="ghost" onClick={() => onReply({ doubt: d, mode: "release" })}>Send to client</Button>}
                          {!d.meeting_id && d.state === "open" && <Button size="sm" kind="ghost" onClick={() => onMeeting(d)}>Make a meeting</Button>}
                          {d.state === "open" && <Button size="sm" kind="ghost" onClick={() => onReply({ doubt: d, mode: "reject" })}>Not now</Button>}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function ReplyDialog({ r, onClose, onDone }) {
  const { doubt: d, mode } = r;
  const [text, setText] = useState(mode === "release" ? d.question || "" : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const cfg = {
    answer: { title: "Answer the developer", label: "Your answer", required: true, button: "Send answer", hint: "Goes back to the developer who asked.", ok: "Answered." },
    release: { title: "Send to the client", label: "What the client should read", required: false, button: "Send to client", hint: "This is the only way a question reaches a client. It goes to the client's group, in your words.", ok: "Sent to the client." },
    reject: { title: "Not now", label: "Note (optional)", required: false, button: "Not now", hint: "The developer is told it is not being taken up now.", ok: "Marked not now." },
  }[mode];
  const submit = async () => {
    if (cfg.required && !text.trim()) return setErr("Write the answer first.");
    setBusy(true);
    try {
      if (mode === "answer") await P.answerDoubt(d.id, text.trim());
      else if (mode === "release") await P.releaseDoubt(d.id, text.trim());
      else await P.rejectDoubt(d.id, text.trim());
      onDone(cfg.ok);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={cfg.title} width={520}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind={mode === "reject" ? "danger" : "primary"} busy={busy} onClick={submit}>{cfg.button}</Button></>}>
      <div className="callout" style={{ margin: 0, alignItems: "flex-start" }}><Icon n="info" size={16} /><span>{d.task_ref ? <b>{d.task_ref} · </b> : null}{m2o(d.kpi_id)}<span style={{ display: "block", whiteSpace: "pre-wrap", marginTop: 4 }}>“{d.question}”</span><span className="mini">— {m2o(d.raised_by_id)}</span></span></div>
      <Field label={cfg.label} required={cfg.required} hint={cfg.hint}><span className="input ta" style={{ height: "auto" }}><textarea rows={4} value={text} onChange={(e) => { setText(e.target.value); setErr(""); }} autoFocus style={TA} /></span></Field>
      {err && <small className="err" style={{ color: "var(--danger)", fontWeight: 700 }}>{err}</small>}
    </Modal>
  );
}
