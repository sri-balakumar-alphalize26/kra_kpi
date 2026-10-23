"use client";
import { useEffect, useMemo, useState } from "react";
import { Avatar, Button, Field, Icon, Input, Modal, Tabs, useFlags, Select } from "@/components/ui";
import { useMe } from "@/lib/me";
import { useResource } from "@/lib/useFetch";
import * as S from "@/lib/services/kpiActions";
import { fmtHM } from "@/lib/services/kpiActions";
import { liveFromAnchor } from "@/lib/liveTime";
import { serverNow } from "@/lib/api";
import OtherTypeInput from "./OtherTypeInput";

/* Every task dialog, keyed by the `dialog` names in actions.js. Each calls
   `onConfirm(payload)`; the runner (TaskActions.jsx) does the server call.
   Wording and rules follow the Odoo board's modals (kpi_action.js). */
export default function TaskDialog({ dialog, task, extra, busy, onClose, onConfirm }) {
  if (!dialog || !task) return null;
  const props = { task, extra, busy, onClose, onConfirm };
  switch (dialog) {
    case "start": return <StartDialog {...props} />;
    case "resume": return <ResumeDialog {...props} />;
    case "pause": return <PauseDialog {...props} />;
    case "pause_all": return <PauseDialog {...props} all />;
    case "complete": return <CompleteDialog {...props} />;
    case "approve": return <ApproveDialog {...props} />;
    case "reject": return <RejectDialog {...props} />;
    case "revert": return <ReasonDialog {...props} title="Revert client sign-off" label="Why is it coming back?" confirm="Revert" danger />;
    case "delete": return <ReasonDialog {...props} title={`Delete ${task.external_ref || "task"}?`} label="Reason (kept in the log)" confirm="Delete task" danger text="Only a task nobody has worked on can be deleted. This cannot be undone." />;
    case "resume_reason": return <ResumeReasonDialog {...props} />;
    case "sendback": return <SendBackDialog {...props} />;
    case "undo_start": return <UndoStartDialog {...props} task={task} />;
    case "add_time": return <AddTimeDialog {...props} />;
    case "reduce_prev": return <ReducePrevDialog {...props} />;
    case "reassign": return <ReassignDialog {...props} />;
    case "switch": return <SwitchDialog {...props} />;
    case "accept": return <AcceptDialog {...props} />;
    case "priority": return <PriorityDialog {...props} />;
    default: return null;
  }
}

const TA = { border: 0, background: "none", outline: 0, resize: "none", width: "100%", height: "100%", font: "inherit", color: "inherit" };
const CHK = { width: 16, height: 16, accentColor: "var(--brand)" };
const Err = ({ children }) => (children ? <small className="err" style={{ color: "var(--danger)", fontSize: 12.5, fontWeight: 700 }}>{children}</small> : null);
const Box = ({ tone = "info", children }) => {
  const c = tone === "warn" ? ["var(--lz-paused-bg)", "var(--pri-important)", "var(--lz-paused)"] : tone === "danger" ? ["var(--over-bg)", "var(--danger)", "var(--over)"] : tone === "ok" ? ["var(--lz-done-bg)", "var(--lz-done)", "var(--lz-done)"] : ["var(--hover)", "var(--border)", "var(--text)"];
  return <div className="callout" style={{ background: c[0], borderColor: c[1], color: c[2], alignItems: "flex-start" }}><span style={{ flex: 1 }}>{children}</span></div>;
};
/* "Task / Completed by / …" lines at the top of a dialog. */
const Facts = ({ rows }) => (
  <dl className="details" style={{ margin: 0 }}>
    {rows.filter(Boolean).map(([k, v]) => <span key={k} style={{ display: "contents" }}><dt>{k}</dt><dd style={{ height: "auto", minHeight: 24, overflowWrap: "anywhere" }}>{v}</dd></span>)}
  </dl>
);
const spentOf = (t) => (t.task_state === "in_progress" && t.timer_start_datetime ? liveFromAnchor(t.timer_start_datetime, t.timer_total_seconds, serverNow()) : (t.timer_total_seconds || 0));

function Title({ task, children }) {
  return <span>{children} <span className="ref" style={{ fontSize: 12, verticalAlign: "middle" }}>{task.external_ref || `#${task.id}`}</span></span>;
}

/* ---- start: agree to the guidelines (Odoo's Start Task modal) ---- */
function StartDialog({ task, busy, onClose, onConfirm }) {
  const [guide, setGuide] = useState(null); /* null loading | "" none | text */
  useEffect(() => {
    let live = true;
    S.fetchTaskDetails(task.id, { fresh: false }).then((r) => { if (live) setGuide(r.ok ? String(r.meta?.guidelines || "").trim() : ""); }).catch(() => { if (live) setGuide(""); });
    return () => { live = false; };
  }, [task.id]);
  return (
    <Modal open onClose={onClose} title={<Title task={task}>Start task</Title>} width={500}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" icon="play" busy={busy} onClick={() => onConfirm({})} autoFocus>I agree — start task</Button></>}>
      <Facts rows={[["Task", task.name]]} />
      {guide && <Box><b>Guidelines</b><div style={{ whiteSpace: "pre-wrap", marginTop: 4, maxHeight: 180, overflow: "auto" }}>{guide}</div></Box>}
      <p className="note" style={{ margin: 0 }}>Please agree to the guidelines before starting. Do you agree to follow all task guidelines and requirements?</p>
    </Modal>
  );
}

/* ---- resume: confirm, with the last pause reason ---- */
function ResumeDialog({ task, busy, onClose, onConfirm }) {
  return (
    <Modal open onClose={onClose} title={<Title task={task}>Resume task</Title>} width={480}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="ok" icon="play" busy={busy} onClick={() => onConfirm({})} autoFocus>Resume task</Button></>}>
      <Facts rows={[["Task", task.name]]} />
      <Box tone="ok"><Icon n="clock" size={14} /> Your timer will start again and this task moves back to <b>In progress</b>.</Box>
      {task.paused_reason && <p className="mini" style={{ margin: 0 }}><Icon n="pause" size={12} /> <b>Previous pause reason:</b> {task.paused_reason}</p>}
    </Modal>
  );
}

/* ---- respond & resume: a self-created task an admin sent back ---- */
function ResumeReasonDialog({ task, busy, onClose, onConfirm }) {
  const [reason, setReason] = useState("");
  return (
    <Modal open onClose={onClose} title={<Title task={task}>Respond &amp; resume</Title>} width={500}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="ok" icon="play" busy={busy} disabled={!reason.trim()} onClick={() => onConfirm({ reason: reason.trim() })}>Resume</Button></>}>
      {task.self_review_note && <Box tone="warn"><b>{task.self_review_by || "Admin"}</b> sent this back:<div style={{ fontStyle: "italic", marginTop: 4, whiteSpace: "pre-wrap" }}>“{task.self_review_note}”</div></Box>}
      <Field label="What did you change / your response?" required hint="The admin will see this on the card.">
        <span className="input ta"><textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="Describe what you fixed…" style={TA} /></span>
      </Field>
    </Modal>
  );
}

/* ---- pause ---- */
/* `all`: the multitask "Pause all" — same reasons, every running task at once.
   Opens on "Moved to another task", the commonest reason (Odoo). Only Other,
   Urgent and Meeting ask for words, max 60 (it shows on the Workday Map). */
function PauseDialog({ task, extra, busy, onClose, onConfirm, all }) {
  const [code, setCode] = useState("priority_task");
  const [note, setNote] = useState("");
  const [team, setTeam] = useState(false);
  const [picked, setPicked] = useState([]);
  const [pq, setPq] = useState("");
  const [err, setErr] = useState("");
  const people = useResource("/kra_kpi/get_people", {}, { enabled: code === "meeting", ttl: 300000 });
  const list = Array.isArray(people.data) ? people.data : (people.data?.people || []);
  const shown = pq.trim() ? list.filter((p) => `${p.name} ${p.role || ""}`.toLowerCase().includes(pq.trim().toLowerCase())) : list;
  const needNote = S.noteRequired(code, team);
  const label = S.PAUSE_REASONS.find((r) => r.code === code)?.label || code;
  const pick = (c) => { setCode(c); setErr(""); if (!S.baseNoteRequired(c)) setNote(""); if (c !== "meeting") { setTeam(false); setPicked([]); } };
  const confirm = () => {
    if (needNote && !note.trim()) {
      setErr(code === "urgent" ? "Please describe the issue — this note is sent to the owner / configured recipients." : code === "meeting" ? "Please say what the meeting is about." : "Please say what you're pausing for.");
      return;
    }
    onConfirm({ reason: S.pauseReasonText(needNote ? note : "", code, team, label, S.PAUSE_NOTE_MAX), reasonCode: code, meetingWithIds: S.meetingIds(code, team, picked) });
  };
  return (
    <Modal open onClose={onClose} title={all ? "Pause all running tasks" : <Title task={task}>Pause</Title>} width={540}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} onClick={confirm}>{all ? "Pause all" : "Confirm pause"}</Button></>}>
      {all && (extra?.tasks || []).length > 0 && <div className="mini" style={{ display: "flex", flexDirection: "column", gap: 2 }}>{extra.tasks.map((at) => <span key={at.id} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>• {at.external_ref ? `${at.external_ref} ` : ""}{at.name}</span>)}</div>}
      {!all && <Facts rows={[["Task", task.name]]} />}
      <b style={{ fontSize: 13 }}>Why are you pausing?</b>
      <div className="chips">
        {S.PAUSE_REASONS.map((r) => <button key={r.code} type="button" className={`pill ${code === r.code ? "on" : ""}`} style={r.code === "urgent" ? { color: "var(--danger)", fontWeight: 700 } : undefined} title={r.code === "priority_task" ? "You're still working — just on something else" : r.code === "urgent" ? "Pause and immediately notify the owner / configured recipients with your note" : undefined} onClick={() => pick(r.code)}>{r.emoji ? <span className="emo">{r.emoji}</span> : null}{r.emoji ? " " : ""}{r.label}</button>)}
      </div>
      {code === "meeting" && (
        <>
          <b style={{ fontSize: 13 }}>Who is it with?</b>
          <label className="chk"><input type="checkbox" checked={team} onChange={(e) => setTeam(e.target.checked)} style={CHK} />Team meeting (everyone)</label>
          {!team && (
            <>
              <Input icon="search" value={pq} onChange={(e) => setPq(e.target.value)} placeholder="Search people…" />
              <div className="people">
                {shown.map((p) => (
                  <label key={p.id}><input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked((s) => e.target.checked ? [...s, p.id] : s.filter((x) => x !== p.id))} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} /><Avatar name={p.name} uid={p.id} size={22} />{p.name}<span className="mini" style={{ marginLeft: "auto" }}>{p.role}</span></label>
                ))}
                {!shown.length && <span className="mini" style={{ padding: 8 }}>{people.loading ? "Loading people…" : pq.trim() ? "Nobody matches" : "No people found"}</span>}
              </div>
              <span className="mini">{picked.length ? `${picked.length} selected` : "Optional — pick anyone who is in it."}</span>
            </>
          )}
        </>
      )}
      {S.baseNoteRequired(code) && (
        <Field label={code === "meeting" ? "What is it about?" : "Reason"} required={code !== "meeting"} className="reveal">
          <span className="input ta" style={{ height: 64 }}><textarea value={note} onChange={(e) => { setNote(e.target.value.slice(0, S.PAUSE_NOTE_MAX)); setErr(""); }} maxLength={S.PAUSE_NOTE_MAX} placeholder={code === "meeting" ? "Short — e.g. sprint planning" : "Why?"} style={TA} /></span>
          <small className="mini" style={{ color: "var(--danger)" }}>Keep it short (max {S.PAUSE_NOTE_MAX}) — this shows on your Workday Map. {note.length}/{S.PAUSE_NOTE_MAX}</small>
        </Field>
      )}
      {code === "urgent" && <span className="mini" style={{ color: "var(--danger)" }}><Icon n="warn" size={12} /> This note will be sent immediately to the owner and any configured recipients.</span>}
      <Err>{err}</Err>
      <small className="mini">Every pause reason is tracked as away-time in your day summary — never counted as productive.</small>
    </Modal>
  );
}

/* ---- complete ---- */
/* Pre-ticks what the task already shows (Odoo openCompleteFromCard): a GitHub
   link → "Verified GitHub URL"; files on its updates → manual + documentation. */
function CompleteDialog({ task, busy, onClose, onConfirm }) {
  const [checks, setChecks] = useState({});
  const [summary, setSummary] = useState("");
  const [partial, setPartial] = useState(true);
  const [inferred, setInferred] = useState([]);
  /* null = not loaded yet. A full Complete needs a user manual on the task
     (the server refuses without one); Partial needs none. */
  const [hasManual, setHasManual] = useState(null);
  /* A Module / App task needs a GitHub link for a full Complete (server rule). */
  const [hasGithub, setHasGithub] = useState(null);
  const [githubRequired, setGithubRequired] = useState(S.needsGithub(task.deliverable_type));
  /* null | { missing: [...] } "What did we miss?" | { confirm: true } submit confirm */
  const [ask, setAsk] = useState(null);
  /* Team-written updates only: what the client attached when raising the task
     (from_client rows) is not the progress summary (server rule too). */
  const [devCount, setDevCount] = useState(typeof task.dev_progress_count === "number" ? task.dev_progress_count : task.progress_count || 0);
  /* What this task's type needs (server: kpi_workflow._completion_rules) and the
     form's own fields (links, database details). null until loaded. */
  const [rules, setRules] = useState(null);
  const [form, setForm] = useState({});
  useEffect(() => {
    let live = true;
    S.fetchTaskDetails(task.id, { fresh: true }).then((r) => {
      if (!live || !r.ok) return;
      const dpc = r.task?.dev_progress_count;
      setDevCount(typeof dpc === "number" ? dpc : Array.isArray(r.progress) ? r.progress.filter((p) => !p.from_client).length : (r.task?.progress_count ?? task.progress_count ?? 0));
      setHasManual((r.manuals || []).length > 0);
      setHasGithub((r.github || []).length > 0);
      const gr = r.task?.github_required;
      setGithubRequired(typeof gr === "boolean" ? gr : S.needsGithub(r.task?.deliverable_type ?? task.deliverable_type));
      const pre = {};
      if ((r.github || []).length) pre.verify_github = true;
      if ((r.files || []).some((f) => !f.from_client)) { pre.user_manual = true; pre.documentation = true; }
      setInferred(Object.keys(pre));
      setChecks((c) => ({ ...pre, ...c }));
      const m = r.meta || {};
      if (Array.isArray(m.completion_rules)) setRules(m.completion_rules);
      const dbd = m.db_details || {};
      setForm({ app_link: m.app_link || "", user_manual_url: m.user_manual_url || "", website_url: m.website_url || "",
                provision_url: dbd.url || "", provision_db_name: dbd.db_name || "", provision_username: dbd.username || "",
                provision_password: dbd.password || "" });
    }).catch(() => {});
    return () => { live = false; };
  }, [task.id]);
  /* Odoo's full Complete needs at least one item ticked (task_complete), not all five. */
  const anyDone = S.CHECKLIST_ITEMS.some((c) => checks[c.key]);
  const hasSummary = !!summary.trim() || devCount > 0;
  const ref = task.external_ref || `#${task.id}`;
  /* The rows this type needs, ticked from what is on the task or typed here. */
  const LINK = { app_link: "app_link", website_url: "website_url", db_url: "provision_url", db_name: "provision_db_name",
                 db_user: "provision_username", db_password: "provision_password" };
  const rows = (rules || []).map((r) => {
    let done = !!r.done;
    if (r.key === "summary") done = hasSummary;
    else if (r.key === "github") done = done || hasGithub === true;
    else if (r.key === "manual") done = done || hasManual === true || !!(form.user_manual_url || "").trim();
    else if (LINK[r.key]) done = !!(form[LINK[r.key]] || "").trim();
    return { ...r, done };
  });
  const req = rows.filter((r) => r.required);
  const reqDone = req.filter((r) => r.done).length;
  const extra = {};
  for (const r of rows) {
    if (r.key === "manual") extra.user_manual_url = form.user_manual_url || "";
    else if (LINK[r.key]) extra[LINK[r.key]] = form[LINK[r.key]] || "";
  }
  const send = (p) => { if (busy) return; setAsk(null); onConfirm({ employeeChecklist: checks, partial: p, summary: summary.trim(), extra: p ? {} : extra }); };
  /* Full Complete never silently disables: what's missing is reported in one popup. */
  const submit = () => {
    if (busy) return;
    if (partial) { send(true); return; }
    const missing = rules ? req.filter((r) => !r.done).map((r) => r.label)
      : S.completeMissing({ hasSummary, hasManual: hasManual === true, githubRequired, hasGithub: hasGithub === true, anyTicked: true });
    setAsk(missing.length ? { missing } : { confirm: true });
  };
  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <>
    <Modal open onClose={onClose} title={<Title task={task}>Complete</Title>} width={540}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="ok" busy={busy} disabled={busy || (partial && !hasSummary)} title={partial && !hasSummary ? "Write a progress note first" : undefined} onClick={submit}>{partial ? "Send for review" : "Complete"}</Button></>}>
      <p className="note" style={{ margin: 0 }}>It goes to an admin for approval{partial ? "" : " (or straight to done when admin acceptance is off)"}.</p>
      {rules && (
        <div className="cr">
          <div className="cr-head"><b>What this task needs</b><span className="mini">Required done: {reqDone} of {req.length}</span></div>
          <span className="bar" style={{ display: "block" }}><i style={{ width: `${req.length ? (reqDone / req.length) * 100 : 100}%`, background: "var(--brand)" }} /></span>
          {rows.filter((r) => r.key !== "summary").map((r) => (
            <div key={r.key} className="cr-row">
              <span className={`cr-dot ${r.done ? "ok" : r.required ? "miss" : ""}`} aria-hidden="true">{r.done ? "✓" : r.required ? "!" : "–"}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <b>{r.label}</b>{r.required ? <span className="cr-req"> ✱</span> : <span className="mini"> optional</span>}
                {r.key === "manual" && <p className="mini" style={{ margin: "2px 0 4px" }}>Upload a PDF / DOC on the task, or paste a link:</p>}
                {r.key === "manual" && <Input value={form.user_manual_url || ""} onChange={setF("user_manual_url")} placeholder="https:// (Google Doc, Drive…)" />}
                {r.key === "github" && !r.done && <p className="mini" style={{ margin: "2px 0 0" }}>Add it on the task's Files tab.</p>}
                {LINK[r.key] && <Input type={r.key === "db_password" ? "password" : "text"} value={form[LINK[r.key]] || ""} onChange={setF(LINK[r.key])}
                  placeholder={r.key === "app_link" ? "Play Store / App Store / APK link" : r.key === "website_url" || r.key === "db_url" ? "https://" : ""} autoComplete="off" />}
              </div>
              <span className={`chip-sm cr-st ${r.done ? "ok" : r.required ? "miss" : ""}`}>{r.done ? "Done" : r.required ? "Missing" : "Optional"}</span>
            </div>
          ))}
        </div>
      )}
      <Field label={devCount > 0 || (rules && rows.some((r) => r.key === "summary" && !r.required)) ? "Progress note (optional)" : "Progress note"} required={!(devCount > 0) && !(rules && rows.some((r) => r.key === "summary" && !r.required))}><span className="input ta"><textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What was done" style={TA} /></span></Field>
      <label className="chk"><input type="checkbox" checked={!partial} onChange={(e) => setPartial(!e.target.checked)} style={CHK} />Mark fully complete</label>
      <p className="mini" style={{ margin: 0 }}>Time spent: {fmtHM(spentOf(task))}</p>
    </Modal>
    {ask?.missing && (
      <Modal open onClose={() => setAsk(null)} title="Before completing, you still need:" width={460}
        footer={<>{hasSummary && <Button kind="ghost" busy={busy} disabled={busy} onClick={() => send(true)}>Send as Partial Finish instead</Button>}<Button kind="primary" onClick={() => setAsk(null)} autoFocus>OK, I'll add them</Button></>}>
        <ul style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 4 }}>
          {ask.missing.map((m) => <li key={m}>{m}</li>)}
        </ul>
      </Modal>
    )}
    {ask?.confirm && (
      <Modal open onClose={() => setAsk(null)} title={`Before Complete · ${ref}`} width={440}
        footer={<><Button kind="ghost" onClick={() => setAsk(null)}>Go back</Button><Button kind="ok" busy={busy} disabled={busy} onClick={() => send(false)} autoFocus>Complete</Button></>}>
        <p className="note" style={{ margin: "0 0 8px" }}>{task.name}</p>
        {rules && <>
          <p style={{ margin: 0 }}><b style={{ color: "var(--ok, #15803d)" }}>✓ Provided</b><br /><span className="mini">{rows.filter((r) => r.done).map((r) => r.label).join(" · ") || "—"}</span></p>
          {rows.some((r) => !r.done && !r.required) && <p style={{ margin: "8px 0 0" }}><b>— Left empty (optional)</b><br /><span className="mini">{rows.filter((r) => !r.done && !r.required).map((r) => r.label).join(" · ")}</span></p>}
        </>}
      </Modal>
    )}
    </>
  );
}

/* ---- approve (admin) ---- */
/* Odoo shows what the task was and who finished it, the developer's checklist,
   and refuses to approve until all six review items are ticked. */
function ApproveDialog({ task, busy, onClose, onConfirm }) {
  const [checks, setChecks] = useState({});
  const [dev, setDev] = useState(undefined);
  useEffect(() => { S.getTaskChecklists(task.id).then((r) => setDev(r?.employee_checklist || r?.employee || null)).catch(() => setDev(null)); }, [task.id]);
  const n = S.MGR_CHECKLIST_ITEMS.filter((c) => checks[c.key]).length;
  const total = S.MGR_CHECKLIST_ITEMS.length;
  return (
    <Modal open onClose={onClose} title={<Title task={task}>Approve — coordinator review</Title>} width={560}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="ok" icon="check" busy={busy} disabled={n < total} title={n < total ? `Tick all ${total} review items (${n}/${total})` : undefined} onClick={() => onConfirm({ managerChecklist: checks })}>Approve task</Button></>}>
      <Facts rows={[["Task", task.name], ["Completed by", task.completed_by_name || "Unknown"], ["Completion date", task.completion_date || "—"], ["Time spent", fmtHM(task.timer_total_seconds)]]} />
      {task.description && <Box><b><Icon n="doc" size={13} /> Description</b><div style={{ whiteSpace: "pre-wrap", maxHeight: 140, overflow: "auto", marginTop: 4 }}>{task.description}</div></Box>}
      <Box>
        <b>Developer's checklist (submitted)</b>
        <div style={{ marginTop: 4 }}>
          {dev === undefined ? "Loading…" : !dev ? "Could not load the developer's checklist." : S.CHECKLIST_ITEMS.map((c) => <div key={c.key}>{dev[c.key] ? "✓" : "✗"} {c.label}</div>)}
        </div>
      </Box>
      <b style={{ fontSize: 13 }}>Coordinator approval checklist</b>
      <div>
        {S.MGR_CHECKLIST_ITEMS.map((c) => (
          <label key={c.key} className="chk"><input type="checkbox" checked={!!checks[c.key]} onChange={(e) => setChecks((s) => ({ ...s, [c.key]: e.target.checked }))} style={CHK} />{c.label}</label>
        ))}
      </div>
      <span className="mini" style={n < total ? { color: "var(--pri-important)" } : undefined}>{n}/{total} ticked{n < total ? " — all items must be completed before approving." : ""}</span>
      <p className="mini" style={{ margin: 0 }}>If client approval is on, the task moves to "Awaiting client" for sign-off; otherwise it is done.</p>
    </Modal>
  );
}

/* ---- reject (admin): what sending it back does ---- */
function RejectDialog({ task, busy, onClose, onConfirm }) {
  const [reason, setReason] = useState("");
  const short = reason.trim().length > 0 && reason.trim().length < 10;
  return (
    <Modal open onClose={onClose} title={<Title task={task}>Reject task</Title>} width={500}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="danger" icon="x" busy={busy} disabled={reason.trim().length < 10} onClick={() => onConfirm({ reason: reason.trim() })}>Reject &amp; send back</Button></>}>
      <Facts rows={[["Task", task.name], ["Completed by", task.completed_by_name || "Unknown"]]} />
      <Box tone="warn">
        <b>Rejecting this task will:</b>
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          <li>Send the task to <b>Paused</b></li>
          <li>Show your feedback to the developer</li>
          <li>Make the developer press <b>Resume</b> to continue</li>
          <li>Keep the timer stopped until they resume</li>
        </ul>
      </Box>
      <Field label="Reason for rejection" required error={short ? "Please give a more detailed reason (at least 10 characters)." : null} hint="This will be shown to the developer.">
        <span className="input ta"><textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="What needs to be improved or corrected…" style={TA} /></span>
      </Field>
    </Modal>
  );
}

/* ---- generic reason ---- */
function ReasonDialog({ task, busy, onClose, onConfirm, title, label, text, confirm, danger, noReason }) {
  const [reason, setReason] = useState("");
  return (
    <Modal open onClose={onClose} title={<Title task={task}>{title}</Title>} width={480}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind={danger ? "danger" : "primary"} busy={busy} disabled={!noReason && !reason.trim()} onClick={() => onConfirm({ reason: reason.trim() })}>{confirm}</Button></>}>
      {text && <p className="note" style={{ margin: 0, whiteSpace: "pre-line" }}>{text}</p>}
      {!noReason && <Field label={label} required><span className="input ta"><textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus style={TA} /></span></Field>}
    </Modal>
  );
}

function SendBackDialog({ task, busy, onClose, onConfirm }) {
  const [note, setNote] = useState("");
  return (
    <Modal open onClose={onClose} title={<Title task={task}>Send back to {task.user_name || "developer"}</Title>} width={480}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="danger" busy={busy} onClick={() => onConfirm({ note: note.trim(), discard: true })}>Discard task</Button><Button kind="primary" busy={busy} disabled={!note.trim()} onClick={() => onConfirm({ note: note.trim(), discard: false })}>Send back</Button></>}>
      {task.self_resume_note && <Box><b>{task.self_resume_by || "Developer"}</b> replied: <span style={{ whiteSpace: "pre-wrap" }}>{task.self_resume_note}</span></Box>}
      <Field label="Note to the developer" required><span className="input ta"><textarea value={note} onChange={(e) => setNote(e.target.value)} autoFocus style={TA} /></span></Field>
      <p className="mini" style={{ margin: 0 }}>Send back keeps it in Pending review with your note on the card; Discard removes it.</p>
    </Modal>
  );
}

/* ---- add time: Odoo's live "new estimate" line ---- */
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const human = (min) => { const h = Math.floor(min / 60), m = min % 60; return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`; };
function AddTimeDialog({ task, busy, onClose, onConfirm }) {
  const [h, setH] = useState("0"); const [m, setM] = useState("0"); const [reason, setReason] = useState("");
  const estMin = (task.estimate_hours || 0) * 60 + (task.estimate_minutes || 0);
  const workedMin = Math.round(spentOf(task) / 60);
  const overNow = workedMin - estMin;
  const added = Math.max(0, parseInt(h, 10) || 0) * 60 + Math.max(0, parseInt(m, 10) || 0);
  const newEst = estMin + added, left = newEst - workedMin;
  const live = added <= 0 ? ["Enter how much to add.", "var(--subtlest)"]
    : left <= 0 ? [`New estimate ${hhmm(newEst)} · still ${human(-left)} over`, "var(--danger)"]
      : [`New estimate ${hhmm(newEst)} · ${human(left)} left`, "var(--pri-regular)"];
  const ok = added > 0 && reason.trim();
  return (
    <Modal open onClose={onClose} title={<Title task={task}>Add time</Title>} width={480}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} disabled={!ok} onClick={() => onConfirm({ hours: parseInt(h, 10) || 0, minutes: parseInt(m, 10) || 0, reason: reason.trim() })}>Add time</Button></>}>
      <Facts rows={[["Current estimate", task.estimate_display || hhmm(estMin)], ["Worked so far", <span key="w">{hhmm(workedMin)}{estMin > 0 && overNow > 0 ? <b style={{ color: "var(--danger)" }}> ⚠ {human(overNow)} over</b> : null}</span>]]} />
      <p className="note" style={{ margin: 0 }}>This is <b>added</b> to the estimate, not a new total.</p>
      <div className="grid2"><Field label="Hours"><Input type="number" min="0" value={h} onChange={(e) => setH(e.target.value)} /></Field><Field label="Minutes"><Input type="number" min="0" max="59" value={m} onChange={(e) => setM(e.target.value)} /></Field></div>
      <span style={{ fontWeight: 700, fontSize: 13, color: live[1] }}>{live[0]}</span>
      <Field label="Reason" required hint="The reason shows on the task card, so write it for whoever reads the board."><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. client added two more screens" /></Field>
    </Modal>
  );
}

/* ---- reduce yesterday: admin takes forgotten time off the previous day ---- */
function ReducePrevDialog({ task, busy, onClose, onConfirm }) {
  const info = useResource("/kra_kpi/task/prev_day_time", { kpi_id: task.id });
  const d = info.data;
  const [h, setH] = useState("0"); const [m, setM] = useState("0");
  const [code, setCode] = useState(""); const [text, setText] = useState("");
  const prevMin = Math.round((d?.seconds || 0) / 60);
  const cut = Math.max(0, parseInt(h, 10) || 0) * 60 + Math.max(0, parseInt(m, 10) || 0);
  const live = cut <= 0 ? ["Enter how much to take off.", "var(--subtlest)"]
    : cut > prevMin ? [`Yesterday has only ${human(prevMin)} — you can take off at most that.`, "var(--danger)"]
      : [`Yesterday becomes ${human(prevMin - cut)} (was ${human(prevMin)})`, "var(--pri-regular)"];
  const ok = d?.status && cut > 0 && cut <= prevMin && code && (code !== "other" || text.trim());
  const people = (d?.people || []).map((p) => `${p.name} ${p.display}`).join(", ");
  return (
    <Modal open onClose={onClose} title={<Title task={task}>Reduce yesterday&apos;s time</Title>} width={500}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="danger" busy={busy} disabled={!ok} onClick={() => onConfirm({ hours: parseInt(h, 10) || 0, minutes: parseInt(m, 10) || 0, reasonCode: code, reasonText: code === "other" ? text.trim() : "" })}>Reduce time</Button></>}>
      {!d ? <p className="note" style={{ margin: 0 }}>Loading yesterday&apos;s time…</p>
        : d.status === false ? <Box tone="danger">{d.message}</Box> : (
          <>
            <Facts rows={[["Day", d.date_display], ["This task", people ? `${d.display} (${people})` : d.display],
              ...(d.day_totals || []).map((x) => [`${x.name} — whole day`, `${x.display} on ${x.tasks} task(s)`]),
              ["Task total so far", d.task_total_display]]} />
            {(d.intervals || []).length > 0 && (
              <div style={{ display: "grid", gap: 2, fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
                {d.intervals.map((i, n) => (
                  <div key={n} style={{ display: "flex", gap: 10 }}>
                    <span style={{ minWidth: 170 }}>{i.start} → {i.end}</span><b>{i.display}</b>
                    {(d.people || []).length > 1 && <span className="mini">{i.who}</span>}
                  </div>
                ))}
              </div>
            )}
            <p className="note" style={{ margin: 0 }}>Takes the forgotten time off the <b>end</b> of yesterday. Only yesterday, only less — it cannot add time.</p>
            <div className="grid2"><Field label="Hours"><Input type="number" min="0" value={h} onChange={(e) => setH(e.target.value)} /></Field><Field label="Minutes"><Input type="number" min="0" max="59" value={m} onChange={(e) => setM(e.target.value)} /></Field></div>
            <span style={{ fontWeight: 700, fontSize: 13, color: live[1] }}>{live[0]}</span>
            <Field label="Reason" required hint="Saved in the task log.">
              <div style={{ display: "grid", gap: 6 }}>
                {(d.reasons || []).map((r) => (
                  <label key={r.key} style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                    <input type="radio" name="reduce-reason" style={CHK} checked={code === r.key} onChange={() => setCode(r.key)} />{r.label}
                  </label>
                ))}
              </div>
            </Field>
            {code === "other" && <Field label="What happened?" required><Input value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. system restarted for updates" /></Field>}
          </>
        )}
    </Modal>
  );
}

/* ---- reassign ---- */
/* The same person is allowed: reassigning resets the task (Odoo). */
function ReassignDialog({ task, busy, onClose, onConfirm }) {
  const users = useResource("/kra_kpi/get_users", {}, { ttl: 300000 });
  const list = users.data?.users || (Array.isArray(users.data) ? users.data : []);
  const [uid, setUid] = useState(task.user_id || null); const [reason, setReason] = useState("");
  const [uq, setUq] = useState("");
  const shown = uq.trim() ? list.filter((u) => String(u.name || "").toLowerCase().includes(uq.trim().toLowerCase())) : list;
  const short = reason.trim().length > 0 && reason.trim().length < 10;
  return (
    <Modal open onClose={onClose} title={<Title task={task}>Reassign</Title>} width={500}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" icon="swap" busy={busy} disabled={!uid || reason.trim().length < 10} onClick={() => onConfirm({ userId: uid, reason: reason.trim() })}>Confirm reassignment</Button></>}>
      <Box tone="warn"><b>Important:</b> reassigning resets the task to <b>{S.priorityLabel(task.priority)}</b> and clears the timer. All progress is recorded in history.</Box>
      <Facts rows={[["Task", task.name], ["Current assignee", task.user_name || "Not assigned"], ["Current state", task.task_state], ["Time spent", fmtHM(spentOf(task))]]} />
      {/* Not a <Field>: that is a <label>, and a list of radios can't sit inside one. */}
      <div className="field"><span>Select new assignee<span className="req" aria-hidden="true"> *</span></span></div>
      {list.length > 8 && <Input icon="search" value={uq} onChange={(e) => setUq(e.target.value)} placeholder="Search people…" />}
      <div className="people">
        {shown.map((u) => (
          <label key={u.id}><input type="radio" name="assignee" checked={uid === u.id} onChange={() => setUid(u.id)} style={{ accentColor: "var(--brand)" }} /><Avatar name={u.name} uid={u.id} size={22} />{u.name}{u.id === task.user_id && <span className="mini" style={{ marginLeft: "auto" }}>current</span>}</label>
        ))}
        {!shown.length && <span className="mini" style={{ padding: 8 }}>{users.loading ? "Loading…" : "No users"}</span>}
      </div>
      <span className="mini">You can reassign to the same person to reset the task.</span>
      <Field label="Reason for reassignment" required error={short ? "Please give a bit more detail (at least 10 characters)." : null}>
        <span className="input ta" style={{ height: 64 }}><textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. workload balancing, availability, skill match" style={TA} /></span>
      </Field>
    </Modal>
  );
}

/* ---- switch (stop this, start that) ---- */
/* Odoo: search by ref / name / developer, paused work first ("pick back up"),
   then not-started; last worked first, ref as the tie-break. */
const SWITCHABLE = ["assigned", "paused", "rework", "regular", "important", "urgent", "hold"];
function SwitchDialog({ task, busy, onClose, onConfirm }) {
  const { me } = useMe();
  const board = useResource(S.TASKS_PATH, { my_tasks_only: false });
  const [pick, setPick] = useState(null); const [note, setNote] = useState(""); const [q, setQ] = useState("");
  const candidates = useMemo(() => (board.data?.tasks || [])
    .filter((t) => t.id !== task.id && t.user_id === me.uid && SWITCHABLE.includes(t.task_state) && t.can_start !== false)
    .sort((a, b) => S.byRecency(a, b) || String(a.external_ref || "").localeCompare(String(b.external_ref || ""))), [board.data, task.id, me.uid]);
  const ql = q.trim().toLowerCase();
  const shown = ql ? candidates.filter((t) => `${t.external_ref || ""} ${t.name || ""} ${t.user_name || ""}`.toLowerCase().includes(ql)) : candidates;
  const groups = [["Paused — pick back up", shown.filter((t) => S.PAUSED_STATES.includes(t.task_state))], ["Not started yet", shown.filter((t) => !S.PAUSED_STATES.includes(t.task_state))]];
  return (
    <Modal open onClose={onClose} title={<Title task={task}>Switch to another task</Title>} width={600}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} disabled={!pick} onClick={() => onConfirm({ toId: pick, note: note.trim() })}>Switch</Button></>}>
      <p className="note" style={{ margin: 0 }}><b>{task.external_ref || task.name}</b> pauses as <b>Moved to another task</b> and the one you pick starts straight away. Anything else you have running is left alone. Time already logged is kept.</p>
      <Input icon="search" value={q} autoFocus onChange={(e) => setQ(e.target.value)} placeholder="Search by ref, name or developer…" />
      <div className="people" style={{ maxHeight: 320 }}>
        {groups.map(([title, arr]) => arr.length > 0 && (
          <div key={title} style={{ display: "contents" }}>
            <span className="mini" style={{ padding: "6px 8px 2px", textTransform: "uppercase" }}>{title} ({arr.length})</span>
            {arr.map((t) => (
              <label key={t.id} style={{ alignItems: "flex-start" }}>
                <input type="radio" name="switchto" checked={pick === t.id} onChange={() => setPick(t.id)} style={{ accentColor: "var(--brand)", marginTop: 3 }} />
                <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}><span className="ref">{t.external_ref || `#${t.id}`}</span><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>{t.name}</span><span className="mini" style={{ marginLeft: "auto", flex: "none" }}>{S.priorityLabel(t.priority)}</span></span>
                  <span className="mini">Time {fmtHM(t.timer_total_seconds)} · est {t.estimate_display || "—"}{t.deadline ? ` · due ${t.deadline}` : ""}</span>
                  {t.paused_reason && S.PAUSED_STATES.includes(t.task_state) && <span className="mini" style={{ color: "var(--lz-paused)" }}>⏸ {t.paused_reason}</span>}
                </span>
              </label>
            ))}
          </div>
        ))}
        {!shown.length && <span className="mini" style={{ padding: 8 }}>{board.loading ? "Loading…" : ql ? `Nothing matches "${q.trim()}".` : "Nothing else is ready to start. A task has to be accepted and approved before you can switch to it."}</span>}
      </div>
      <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why you're switching" /></Field>
    </Modal>
  );
}

/* ---- accept a self-created task (admin) ---- */
function AcceptDialog({ task, extra, busy, onClose, onConfirm }) {
  const [doc, setDoc] = useState(task.requested_doc_type || "requirement");
  const [pri, setPri] = useState(extra?.priority || task.requested_priority || task.priority || "regular");
  return (
    <Modal open onClose={onClose} title={<Title task={task}>Accept into the flow</Title>} width={480}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} onClick={() => onConfirm({ docType: doc, priority: pri })}>Accept</Button></>}>
      <p className="note" style={{ margin: 0 }}>{task.user_name} raised this themselves{task.requested_priority ? ` and asked for ${task.requested_priority}` : ""}. Categorise it; it gets a real REQ/UPT/BUG number.</p>
      {task.description && <Box><div style={{ whiteSpace: "pre-wrap", maxHeight: 140, overflow: "auto" }}>{task.description}</div></Box>}
      <Field label="Type"><Tabs items={[{ key: "requirement", label: "REQ" }, { key: "update", label: "UPT" }, { key: "bug", label: "BUG" }]} value={doc} onChange={setDoc} /></Field>
      <Field label="Priority"><Tabs items={S.PRIORITIES.map((p) => ({ key: p.code, label: p.label }))} value={pri} onChange={setPri} /></Field>
    </Modal>
  );
}

/* ---- priority (admin) ---- */
function PriorityDialog({ task, extra, busy, onClose, onConfirm }) {
  const [pri, setPri] = useState(extra?.priority || task.priority || "regular");
  return (
    <Modal open onClose={onClose} title={<Title task={task}>Priority</Title>} width={420}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} disabled={pri === task.priority} onClick={() => onConfirm({ priority: pri })}>Set priority</Button></>}>
      <Tabs items={S.PRIORITIES.map((p) => ({ key: p.code, label: p.label }))} value={pri} onChange={setPri} />
    </Modal>
  );
}

/* ---- create task (the top-nav "+ Create") ---- */
/* New task: Odoo's New Task modal — Type REQ/UPT/BUG (doc_type, what the creator
   thinks it is), Module/App/EXE as multi-select (at least one). Already done
   (admin): Odoo's Add Done Task — the route always numbers it REQ and takes no
   type; its estimate fills from the time worked (estimateFromWorked). Neither
   route takes a deadline, so there is no deadline field. */
export function CreateTaskDialog({ open, onClose, onCreated }) {
  const { me } = useMe();
  const flags = useFlags();
  const admin = me.role === "admin";
  const [mode, setMode] = useState("new"); /* new | done (admin: already-done task) */
  const [clients, setClients] = useState(null);
  const [client, setClient] = useState(""); const [kra, setKra] = useState("");
  const [name, setName] = useState(""); const [desc, setDesc] = useState("");
  const [deliv, setDeliv] = useState([]); const [pri, setPri] = useState("regular");
  const [delivOther, setDelivOther] = useState("");
  const [docType, setDocType] = useState("requirement");
  const [h, setH] = useState("0"); const [m, setM] = useState("0");
  const [userId, setUserId] = useState(0); const [workDate, setWorkDate] = useState(() => S.localDay(Date.now()));
  const [wh, setWh] = useState("0"); const [wm, setWm] = useState("0");
  const [estTouched, setEstTouched] = useState(false); /* done mode: estimate follows time worked until edited */
  const [matches, setMatches] = useState([]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const users = useResource("/kra_kpi/get_users", {}, { enabled: open && admin, ttl: 300000 });
  const userList = users.data?.users || (Array.isArray(users.data) ? users.data : []);
  const delivStr = S.DELIVERABLES.map((d) => d.code).filter((c) => deliv.includes(c)).join(",");

  useEffect(() => { if (open && !clients) S.fetchClientTree().then(setClients).catch(() => setClients([])); }, [open, clients]);
  useEffect(() => {
    if (!open || !kra || name.trim().length < 4) { setMatches([]); return; }
    const t = setTimeout(() => S.findNameMatches(name.trim(), +kra).then((r) => setMatches(r?.matches || [])), 400);
    return () => clearTimeout(t);
  }, [name, kra, open]);
  const projects = useMemo(() => clients?.find((c) => String(c.id) === String(client))?.projects || [], [clients, client]);
  useEffect(() => { if (projects.length && !projects.some((p) => String(p.id) === String(kra))) setKra(String(projects[0].id)); }, [projects, kra]);
  /* Done mode: the estimate follows the time worked and the types (Odoo
     syncEstimate) until the admin types one of their own. */
  useEffect(() => {
    if (mode !== "done" || estTouched) return;
    const worked = (parseInt(wh, 10) || 0) * 3600 + (parseInt(wm, 10) || 0) * 60;
    if (worked <= 0) { setH(""); setM(""); return; }
    const est = S.estimateFromWorked(worked, delivStr);
    setH(String(Math.floor(est / 3600))); setM(String(Math.floor((est % 3600) / 60)));
  }, [mode, wh, wm, delivStr, estTouched]);
  useEffect(() => { if (mode === "new") { setEstTouched(false); setH("0"); setM("0"); } }, [mode]);

  if (!open) return null;
  const toggleDeliv = (c) => setDeliv((d) => (d.includes(c) ? d.filter((x) => x !== c) : [...d, c]));
  const submit = async () => {
    setErr("");
    if (!name.trim()) { setErr("Please enter a task name."); return; }
    if (!kra) { setErr("Please choose a client and project."); return; }
    if (!delivStr) { setErr("Tick at least one type — Module, App, EXE or Other."); return; }
    const otherText = S.deliverableOtherValue(delivStr, delivOther);
    if (S.hasOtherDeliverable(delivStr) && !otherText) { setErr(S.DELIVERABLE_OTHER_REQUIRED); return; }
    let estH = parseInt(h, 10) || 0, estM = parseInt(m, 10) || 0;
    if (estM > 59) { setErr("Estimate minutes must be between 0 and 59."); return; }
    let workedSec = 0;
    if (mode === "done") {
      workedSec = (parseInt(wh, 10) || 0) * 3600 + (parseInt(wm, 10) || 0) * 60;
      if (workedSec <= 0) { setErr("Enter the time worked."); return; }
      if ((parseInt(wm, 10) || 0) > 59) { setErr("Minutes worked must be between 0 and 59."); return; }
      if (!workDate) { setErr("Please choose the work date."); return; }
      if (h === "" && m === "") { const est = S.estimateFromWorked(workedSec, delivStr); estH = Math.floor(est / 3600); estM = Math.floor((est % 3600) / 60); }
      else if (estH * 3600 + estM * 60 <= workedSec) { setErr("Estimate must be more than the time worked — or leave it blank."); return; }
    }
    setBusy(true);
    try {
      const res = mode === "done"
        ? await S.adminCreateDoneTask({ name: name.trim(), kraId: +kra, userId: +userId || 0, workedSeconds: workedSec, workDate, estimateHours: estH, estimateMinutes: estM, deliverableType: delivStr, deliverableOther: otherText, priority: pri, description: desc })
        : await S.selfCreateTask({ name: name.trim(), kraId: +kra, estimateHours: estH, estimateMinutes: estM, priority: pri, docType, description: desc, userId: admin ? +userId || 0 : 0, deliverableType: delivStr, deliverableOther: otherText });
      S.assertOk(res, "Could not create the task.");
      flags.ok(mode === "done" ? `${res.external_ref || "Task"} added to Pending Approvals.` : res.message || "Task created in Pending review.");
      setName(""); setDesc(""); setMatches([]); setEstTouched(false); setDeliv([]); setDelivOther(""); setDocType("requirement");
      onCreated?.(res);
      onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={mode === "done" ? "Add done task" : "New task — Pending review"} width={620}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} onClick={submit}>{mode === "done" ? "Add done task" : "Create task"}</Button></>}>
      {admin && <Tabs items={[{ key: "new", label: "New task" }, { key: "done", label: "Already done" }]} value={mode} onChange={setMode} />}
      <div className="grid2">
        <Field label="Client" required><span className="input"><Select value={client} onChange={(e) => setClient(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}><option value="">{clients ? "Choose a client" : "Loading…"}</option>{(clients || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></span></Field>
        <Field label="Project / version" required><span className="input"><Select value={kra} onChange={(e) => setKra(e.target.value)} disabled={!projects.length} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}>{projects.map((p) => <option key={p.id} value={p.id}>{p.display}</option>)}</Select></span></Field>
      </div>
      <Field label="Task name" required><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder={mode === "done" ? "What was done?" : "What needs doing?"} /></Field>
      {matches.length > 0 && <div className="callout" style={{ background: "var(--lz-paused-bg)", borderColor: "var(--pri-important)", color: "var(--lz-paused)", padding: "8px 12px" }}><span>Already used in this project: {matches.slice(0, 3).map((x) => `${x.external_ref || ""} ${x.name || x}${x.assignee ? ` (${x.assignee})` : ""}`.trim()).join(" · ")}</span></div>}
      <div className="fit-row">
        {mode === "new" && <Field label="Type" hint="What you think it is — the admin makes the final call on Accept."><Tabs items={[{ key: "requirement", label: "REQ" }, { key: "update", label: "UPT" }, { key: "bug", label: "BUG" }]} value={docType} onChange={setDocType} /></Field>}
        <Field label="Module / App / EXE / Other (tick one or more)" required>
          <span className="chips" style={{ margin: 0 }}>
            {S.DELIVERABLES.map((d) => <label key={d.code} className="chk" style={{ marginRight: 10 }}><input type="checkbox" checked={deliv.includes(d.code)} onChange={() => toggleDeliv(d.code)} style={CHK} />{d.label}</label>)}
          </span>
        </Field>
        {deliv.includes("other") && <OtherTypeInput value={delivOther} onChange={setDelivOther} autoFocus />}
        <Field label="Priority"><Tabs items={S.PRIORITIES.map((p) => ({ key: p.code, label: p.label }))} value={pri} onChange={setPri} /></Field>
      </div>
      <div className="fit-row">
        {mode === "done" && <Field label="Time worked" required className="grow"><span style={{ display: "flex", gap: 6 }}><Input type="number" min="0" value={wh} onChange={(e) => setWh(e.target.value)} right={<span className="ph">h</span>} /><Input type="number" min="0" max="59" value={wm} onChange={(e) => setWm(e.target.value)} right={<span className="ph">m</span>} /></span></Field>}
        <Field label={mode === "done" ? "Estimate" : "Estimate (optional)"} className="grow" hint={mode === "done" ? "Fills in from the time worked and the type: 20–40% more, at most +2h for a Module or EXE, +3h if App is ticked. It must stay above the time worked." : "The admin can set or correct it when accepting."}><span style={{ display: "flex", gap: 6 }}><Input type="number" min="0" value={h} onChange={(e) => { setEstTouched(true); setH(e.target.value); }} right={<span className="ph">h</span>} /><Input type="number" min="0" max="59" value={m} onChange={(e) => { setEstTouched(true); setM(e.target.value); }} right={<span className="ph">m</span>} /></span></Field>
      </div>
      {admin && (
        <div className="grid2">
          <Field label="Developer" hint={mode === "done" ? "Who did the work. The time is recorded against them." : "Who this task is for. Defaults to you."}><span className="input"><Select value={userId} onChange={(e) => setUserId(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}><option value={0}>Me ({me.name})</option>{userList.filter((u) => u.id !== me.uid).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></span></Field>
          {mode === "done" && <Field label="Work date" required hint="The day the work was done — today or earlier."><Input type="date" value={workDate} max={S.localDay(Date.now())} onChange={(e) => setWorkDate(e.target.value)} /></Field>}
        </div>
      )}
      <Field label="Description (optional)"><span className="input ta"><textarea value={desc} onChange={(e) => setDesc(e.target.value)} style={TA} /></span></Field>
      {err && <span className="err" style={{ color: "var(--danger)", fontSize: 12.5, fontWeight: 700 }}>{err}</span>}
      {mode === "new"
        ? <p className="mini" style={{ margin: 0 }}>This goes to your <b>Pending review</b> lane. <b>Start stays locked</b> until an admin accepts it — which happens automatically if nobody acts within the accept window. Your client is then asked to approve, and the task releases for work once they do (or automatically if they don't reply in time).</p>
        : <p className="mini" style={{ margin: 0 }}>This goes straight to <b>Pending approvals</b> as a finished task — it still needs approving. The time counts in the KRA, employee and invoice reports on the work date, but <b>not as attendance</b> or productive time for the day.</p>}
    </Modal>
  );
}

/* Undo start: also says what STAYS (today's updates, links, files…) — the
   server counts them (kra.kpi._undo_keeps_line). */
function UndoStartDialog({ task, ...props }) {
  const [keeps, setKeeps] = useState("");
  useEffect(() => { S.undoStartInfo(task.id).then((r) => setKeeps(r?.keeps || "")).catch(() => {}); }, [task.id]);
  const base = `${task.external_ref || "The task"} goes back to how it was before today's first start and today's time on it is removed.`;
  return <ReasonDialog {...props} title="Undo today's start?" text={keeps ? `${base}

✅ ${keeps}` : base} confirm="Undo start" noReason />;
}
