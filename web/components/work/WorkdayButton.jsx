"use client";
/* Start / End workday, in the top bar (left of Create). Same states as the
   app's workdayButtonState; "End" opens the End Workday summary first. Once the
   day is ended, developers see it greyed out; an admin can reopen their own day
   (Odoo's /kpi_workday/revert needs a reason) and it starts again straight away.
   A PAUSED day (/kpi_workday/pause, offered inside the End Workday dialog like
   the Odoo board) shows Resume next to End: it is the one thing needed then. */
import { useEffect, useState } from "react";
import { Button, Icon, useDialogs, useFlags } from "@/components/ui";
import { useMe } from "@/lib/me";
import { getPref, setPref } from "@/lib/prefs";
import * as S from "@/lib/services/kpiActions";
import { revertWorkday } from "@/lib/services/admin";
import { useTaskActions } from "@/components/task/TaskActions";
import EndWorkdayDialog from "./EndWorkdayDialog";

export function WorkdayButton({ compact = false }) {
  const acts = useTaskActions();
  const flags = useFlags();
  const dlg = useDialogs();
  const [busy, setBusy] = useState(false);
  const [ending, setEnding] = useState(false); /* End Workday summary open */
  const { me } = useMe();
  const live = acts.workday.data;
  /* Odoo's status call can take a few seconds. Show the last state this
     browser saw right away (refreshed when the live one lands), or a
     placeholder on the very first visit, instead of an empty gap. */
  const [cached] = useState(() => getPref("workday", me?.uid, null));
  useEffect(() => { if (live) setPref("workday", me?.uid, { is_open: !!live.is_open, is_paused: !!live.is_paused, day_done: !!live.day_done, today_closed: !!live.today_closed, reopened_reason: live.reopened_reason || "", reopened_by: live.reopened_by || "" }); }, [live, me?.uid]);
  const w = live || cached;
  if (!w) return <Button kind="primary" disabled busy title="Checking your workday…">Workday</Button>;
  /* Odoo sends who reopened today and why while that reopen is still live. */
  const reopened = w.reopened_reason || w.reopened_by ? { by: w.reopened_by, reason: w.reopened_reason } : null;
  const st = workdayState(w, me?.role === "admin", !!reopened);

  const start = async (msg) => {
    S.assertOk(await S.startWorkday(), "Could not start the workday.");
    flags.ok(msg);
    acts.refreshAll();
  };
  const go = async () => {
    if (st.action === "end") { setEnding(true); return; }
    if (st.action === "reopen") {
      const v = await dlg.form({ title: "Reopen your workday?", confirmLabel: "Reopen & start",
        text: "Your ended day opens again and the clock starts now. The people who got today's summary are told it was reopened.",
        fields: [{ key: "reason", label: "Why are you reopening it?", value: "", placeholder: "e.g. Client call in the evening" }] });
      if (!v) return;
      setBusy(true);
      try {
        S.assertOk(await revertWorkday(me.uid, v.reason.trim()), "Could not reopen the workday.");
        await start("Workday reopened.");
      } catch (e) { flags.err(e.message); acts.refreshAll(); } finally { setBusy(false); }
      return;
    }
    if (st.action !== "start") return;
    setBusy(true);
    try { await start("Workday started."); } catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  const resume = async () => {
    setBusy(true);
    try { const r = S.assertOk(await S.resumeWorkday(), "Could not resume the workday."); flags.ok(r.message || "Workday resumed."); acts.refreshAll(); }
    catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  return (
    <>
      {w.is_open && w.is_paused && <Button kind="ok" icon="play" busy={busy} disabled={!live} onClick={resume} title="Start the clock again">{compact ? "Resume" : "Resume workday"}</Button>}
      {reopened && <span className="reopen-tag" title={`Reopened${reopened.by ? ` by ${reopened.by}` : ""}${reopened.reason ? ` — ${reopened.reason}` : ""}`}>↺ Reopened</span>}
      <Button kind={st.action === "end" ? "danger" : "primary"} busy={busy} disabled={st.disabled || !live} onClick={go} icon={st.action === "end" ? "logout" : st.action === "none" ? "check" : "play"} title={st.label}>
        {compact ? st.short : st.label}
      </Button>
      {ending && <EndWorkdayDialog reopened={reopened} paused={!!w.is_paused} onClose={() => setEnding(false)} onEnded={() => { setEnding(false); flags.ok("Workday ended. See you tomorrow."); acts.refreshAll(); }}
        onPaused={(msg) => { setEnding(false); flags.ok(msg || "Workday paused."); acts.refreshAll(); }} />}
    </>
  );
}
export default WorkdayButton;

/* Board / Your work: say loudly that the day is frozen. The board looks normal
   but nothing will start, and without this the refusals read as a bug. */
export function WorkdayPausedBanner() {
  const acts = useTaskActions();
  const flags = useFlags();
  const [busy, setBusy] = useState(false);
  const w = acts.workday.data;
  if (!w?.is_open || !w.is_paused) return null;
  const resume = async () => {
    setBusy(true);
    try { const r = S.assertOk(await S.resumeWorkday(), "Could not resume the workday."); flags.ok(r.message || "Workday resumed."); acts.refreshAll(); }
    catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="callout reveal" style={{ background: "var(--hover)", borderColor: "var(--subtle)", color: "var(--text)", marginBottom: 8 }}>
      <Icon n="pause" size={18} />
      <span style={{ flex: 1 }}><b>Your workday is paused.</b> Tasks can't be started, and paused time doesn't count as worked time.</span>
      <Button size="sm" kind="ok" icon="play" busy={busy} onClick={resume}>Resume workday</Button>
    </div>
  );
}

function workdayState(w, admin, reopened) {
  if (w.is_open) return { label: "End workday", short: "End workday", action: "end", disabled: false };
  if (w.day_done && admin) return { label: "Reopen your workday for today", short: "Reopen workday", action: "reopen", disabled: false };
  if (w.day_done) return { label: "Workday ended for today", short: "Workday ended", action: "none", disabled: true };
  if (w.today_closed && reopened) return { label: "Reopen and continue workday", short: "Reopen workday", action: "start", disabled: false };
  if (w.today_closed) return { label: "Start new workday session", short: "New session", action: "start", disabled: false };
  return { label: "Start workday", short: "Start workday", action: "start", disabled: false };
}
