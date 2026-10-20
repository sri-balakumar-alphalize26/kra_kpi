"use client";
/* "Not on a task?" — the web port of the Odoo board's / app's idle flow.

   IdlePrompt (mounted once in the Shell) opens by itself when live_status says
   idle_prompt: from the moment the workday opens with nothing running, then
   again each time the server's 10-minute check bumps idle_prompt_seq (max 3).
   Closing it snoozes for 60s, like the other clients. It can also be opened
   from the "Not on a task?" button (window event "kpi:idle").

   NowStrip (Board) shows what is happening when no task runs: a running
   non-task block with switch chips, or a paused task's break with Resume, or
   the "Not on a task?" button. A block ends by itself when a task starts or
   another reason is picked; "End" (/kpi_workday/end_nontask) is for when the
   meeting is over and no task follows — the server then says ask_again and
   the "Not on a task?" dialog opens straight away. */
import { useEffect, useRef, useState } from "react";
import { Avatar, Button, Modal, useDialogs, useFlags } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import { useNow, fmtClock, secsSince } from "@/lib/liveTime";
import * as S from "@/lib/services/kpiActions";
import { useTaskActions } from "@/components/task/TaskActions";

const SNOOZE_MS = 60000;

export function IdlePrompt() {
  const acts = useTaskActions();
  const live = acts.live.data;
  const [open, setOpen] = useState(false);
  const asked = useRef(0);
  const snoozeUntil = useRef(0);

  useEffect(() => {
    if (!live) return;
    if (!live.idle_prompt) { asked.current = 0; snoozeUntil.current = 0; return; }
    const seq = live.idle_prompt_seq || 0;
    if (!live.is_paused && Date.now() >= snoozeUntil.current && seq > asked.current) { asked.current = seq; setOpen(true); }
  }, [live]);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener("kpi:idle", on);
    return () => window.removeEventListener("kpi:idle", on);
  }, []);
  /* Something started (a task, a block) while it was open: nothing to ask. */
  useEffect(() => { if (open && live && (live.active_task || live.nontask)) setOpen(false); }, [open, live]);

  const snooze = () => { snoozeUntil.current = Date.now() + SNOOZE_MS; asked.current = 0; setOpen(false); };
  if (!open) return null;
  return <IdleDialog onClose={snooze} onDone={() => { setOpen(false); acts.refreshAll(); }} />;
}

function IdleDialog({ onClose, onDone }) {
  const flags = useFlags();
  const [meeting, setMeeting] = useState(false);
  const [note, setNote] = useState("");
  const [team, setTeam] = useState(false);
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(null);

  const choose = async (code) => {
    setBusy(code);
    try {
      const n = note.trim().slice(0, S.IDLE_NOTE_MAX) || (code === "meeting" && team ? S.TEAM_MEETING_LABEL : "");
      S.assertOk(await S.setIdleReason(code, n, code === "meeting" && !team ? picked : []), "Could not save that.");
      flags.ok(code === "no_tasks" ? "Your admins have been told you have no tasks." : "Saved to your Workday Map.");
      onDone();
    } catch (e) { flags.err(e.message); } finally { setBusy(null); }
  };

  return (
    <Modal open onClose={onClose} title="Not on a task?" width={520}
      footer={<Button kind="ghost" onClick={onClose}>I have a task — let me start it</Button>}>
      <p className="note" style={{ margin: 0 }}>Nothing is running. Tell us why so your time is recorded correctly.</p>
      <div className="idle-guide">
        <span>• Meeting before your task? Click <b>In a meeting</b>.</span>
        <span>• Nothing assigned yet? Click <b>I have no tasks</b>.</span>
        <span>• Ready to work? Close this and press <b>Start</b> on your task.</span>
      </div>
      <div className="idle-opts">
        {S.IDLE_REASONS.map((r) => (
          <button key={r.code} type="button" disabled={!!busy}
            className={`idle-opt ${r.code === "no_tasks" ? "alert" : ""} ${r.code === "meeting" && meeting ? "on" : ""}`}
            onClick={() => (r.code === "meeting" ? setMeeting((m) => !m) : choose(r.code))}>
            <b>{r.emoji} {r.label}{busy === r.code ? " …" : ""}</b><small>{r.note}</small>
          </button>
        ))}
      </div>
      {meeting && <MeetingPicker team={team} setTeam={setTeam} picked={picked} setPicked={setPicked} busy={busy === "meeting"} onStart={() => choose("meeting")} />}
      <label className="field">
        <span className="input"><input value={note} maxLength={S.IDLE_NOTE_MAX} onChange={(e) => setNote(e.target.value)} placeholder="Optional note (e.g. sprint planning)…" style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }} /></span>
        <small className="mini">Keep it short (max {S.IDLE_NOTE_MAX}) — this shows on your Workday Map. {note.length}/{S.IDLE_NOTE_MAX}</small>
      </label>
    </Modal>
  );
}

function MeetingPicker({ team, setTeam, picked, setPicked, busy, onStart }) {
  const people = useResource("/kra_kpi/get_people", {}, { ttl: 300000 });
  const list = Array.isArray(people.data) ? people.data : (people.data?.people || []);
  return (
    <div className="idle-meet reveal">
      <b style={{ color: "var(--navy)" }}>Who is it with?</b>
      <label className="chk"><input type="checkbox" checked={team} onChange={(e) => setTeam(e.target.checked)} style={{ width: 16, height: 16, accentColor: "var(--brand)" }} />Team meeting (everyone)</label>
      {!team && (
        <div className="people" style={{ maxHeight: 180, overflowY: "auto" }}>
          {list.map((p) => (
            <label key={p.id}><input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked((s) => (e.target.checked ? [...s, p.id] : s.filter((x) => x !== p.id)))} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} /><Avatar name={p.name} uid={p.id} size={22} />{p.name}</label>
          ))}
          {!list.length && <span className="mini" style={{ padding: 8 }}>{people.loading ? "Loading people…" : "No people found"}</span>}
        </div>
      )}
      <Button kind="primary" busy={busy} onClick={onStart}>{team ? "Start team meeting" : picked.length ? `Start meeting with ${picked.length}` : "Start meeting"}</Button>
    </div>
  );
}

/* What's happening when no task runs (Board header strip). */
export function NowStrip() {
  const acts = useTaskActions();
  const flags = useFlags();
  const dlg = useDialogs();
  const live = acts.live.data;
  const now = useNow(!!(live?.nontask || live?.active_break));
  const [busy, setBusy] = useState(null);
  if (!live || !live.workday_open || live.active_task) return null;

  const run = async (key, fn, ok) => {
    setBusy(key);
    try { S.assertOk(await fn(), "That didn't work."); if (ok) flags.ok(ok); acts.refreshAll(); }
    catch (e) { flags.err(e.message); } finally { setBusy(null); }
  };

  const nt = live.nontask;
  if (nt) {
    const switchTo = async (r) => {
      const yes = await dlg.confirm({
        title: `Switch to ${r.label}?`, confirmLabel: "Yes, switch",
        text: `${nt.reason_label} (started ${nt.start_display}) ends now and is saved to your Workday Map — nothing is lost. ${r.emoji} ${r.label} starts now.${r.code === "no_tasks" ? " Your admins will be told straight away." : ""}`,
      });
      if (yes) run(r.code, () => S.setIdleReason(r.code, ""), r.code === "no_tasks" ? "Your admins have been told you have no tasks." : null);
    };
    const endBlock = async () => {
      setBusy("end");
      try {
        const res = S.assertOk(await S.endNonTask(), "Couldn't end that.");
        flags.ok(`${nt.reason_label} ended.`);
        acts.refreshAll();
        /* Wait for live_status to drop the block first, or IdlePrompt sees the
           stale nontask and closes itself again. */
        if (res.ask_again) { await acts.live.refresh(); window.dispatchEvent(new Event("kpi:idle")); }
      } catch (e) { flags.err(e.message); } finally { setBusy(null); }
    };
    return (
      <div className="now-strip">
        <span className="now-pill">⏸ {nt.reason_label} · started {nt.start_display} · {fmtClock(secsSince(nt.start_raw, now))}</span>
        {S.IDLE_REASONS.filter((r) => r.code !== nt.reason).map((r) => (
          <button key={r.code} type="button" className={`pill ${r.code === "no_tasks" ? "alert" : ""}`} disabled={!!busy} onClick={() => switchTo(r)}>{r.emoji} {r.label}</button>
        ))}
        <Button size="sm" kind="ghost" icon="check" busy={busy === "end"} disabled={!!busy && busy !== "end"} onClick={endBlock} title="End this now, without starting a task">End</Button>
        <span className="mini">Starting a task, or another reason, ends this automatically.</span>
      </div>
    );
  }

  const br = live.active_break;
  if (br) {
    return (
      <div className="now-strip">
        <span className="now-pill brk">☕ {br.type_label}{br.source_task_name ? ` (from "${br.source_task_name}")` : ""} · started {br.start_display} · {fmtClock(secsSince(br.start_raw, now))}</span>
        {br.source_task_id && <Button size="sm" kind="primary" icon="play" busy={busy === "resume"} onClick={() => run("resume", () => S.resumeTask(br.source_task_id), "Resumed.")}>Resume</Button>}
        {S.BREAK_SWITCH_REASONS.filter((r) => r.code !== br.type).map((r) => (
          <button key={r.code} type="button" className="pill" disabled={!!busy} onClick={() => run(r.code, () => S.switchBreak(r.code, ""), `Switched to ${r.label}.`)}>{r.emoji} {r.label}</button>
        ))}
        <button type="button" className="pill alert" disabled={!!busy} onClick={() => run("no_tasks", () => S.setIdleReason("no_tasks", ""), "Your admins have been told you have no tasks.")}>📭 I have no tasks</button>
      </div>
    );
  }

  return (
    <div className="now-strip">
      <span className="mini">⏸ No task running</span>
      <button type="button" className="pill idle-ask" onClick={() => window.dispatchEvent(new Event("kpi:idle"))}>Not on a task?</button>
    </div>
  );
}
