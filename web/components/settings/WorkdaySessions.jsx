"use client";
/* Settings › Workday Sessions — Odoo's kpi.work.session list (System only).
   Read-only like the Odoo form in practice: the one action is Reopen, for a day
   ended today that isn't auto-closed or already reopened (/kpi_workday/revert,
   which needs a reason). State is deliberately not editable here. */
import { useCallback, useEffect, useState } from "react";
import { Avatar, Button, ErrorState, Lozenge, PageHeader, Skeleton, useDialogs, useFlags } from "@/components/ui";
import * as X from "@/lib/services/sysadmin";
import SettingsNav from "./SettingsNav";
import SystemOnly from "./SystemOnly";

const PAGE = 80;
const FILTERS = [["today", "Today"], ["open", "Open"], ["closed", "Closed"], ["auto", "Auto-closed"], ["all", "All"]];

export default function WorkdaySessions() {
  return <SystemOnly title="Workday sessions"><Sessions /></SystemOnly>;
}

function Sessions() {
  const flags = useFlags();
  const dlg = useDialogs();
  const [filter, setFilter] = useState("today");
  const [who, setWho] = useState("");
  const [day, setDay] = useState("");
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState(null);
  const [more, setMore] = useState(false);
  const today = X.todayIso();

  const domain = useCallback(() => {
    const d = [];
    if (filter === "today") d.push(["session_date", "=", today]);
    if (filter === "open") d.push(["state", "=", "open"]);
    if (filter === "closed") d.push(["state", "=", "closed"]);
    if (filter === "auto") d.push(["auto_closed", "=", true]);
    if (day) d.push(["session_date", "=", day]);
    if (who.trim()) d.push(["user_id.name", "ilike", who.trim()]);
    return d;
  }, [filter, day, who, today]);

  const load = useCallback(async () => {
    try {
      const dm = domain();
      const [r, n] = await Promise.all([X.listSessions(dm, PAGE, 0), X.countSessions(dm)]);
      setRows(r || []); setTotal(n || 0); setErr(null);
    } catch (e) { setErr(e); }
  }, [domain]);
  useEffect(() => { const t = setTimeout(load, who ? 300 : 0); return () => clearTimeout(t); }, [load, who]);

  const loadMore = async () => {
    setMore(true);
    try { const r = await X.listSessions(domain(), PAGE, rows.length); setRows((x) => [...x, ...(r || [])]); }
    catch (e) { flags.err(e.message); } finally { setMore(false); }
  };

  const reopen = async (s) => {
    const v = await dlg.form({ title: `Reopen ${X.m2o(s.user_id)}'s workday?`, confirmLabel: "Reopen",
      text: "They ended today already. Reopening lets them start again; they are told, in your words, and everyone who got today's summary hears it was reopened.",
      fields: [{ key: "reason", label: "Why are you reopening it?", value: "", placeholder: "e.g. Client call in the evening" }] });
    if (!v) return;
    try { X.ok(await X.revertWorkday(s.user_id[0], v.reason.trim()), "Could not reopen."); flags.ok("Workday reopened."); load(); }
    catch (e) { flags.err(e.message); }
  };
  const canReopen = (s) => s.state === "closed" && s.session_date === today && !s.auto_closed && !s.reverted;

  return (
    <>
      <PageHeader crumbs={[{ label: "Settings" }, { label: "Workday sessions" }]} title="Workday sessions" meta="Every start and end of a workday, newest first">
        <div className="tabs">{FILTERS.map(([k, l]) => <span key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)} style={{ cursor: "pointer" }}>{l}</span>)}</div>
      </PageHeader>
      <SettingsNav />
      <div className="page">
        <div className="toolbar">
          <label className="search" style={{ margin: 0, width: 240 }}><input value={who} onChange={(e) => setWho(e.target.value)} placeholder="Search a person" aria-label="Search a person" /></label>
          <span className="input" style={{ height: 34 }}><input type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)} aria-label="Day" style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit" }} /></span>
          {day && <Button size="sm" kind="ghost" onClick={() => setDay("")}>Any day</Button>}
          <span className="right"><span className="mini">{rows ? `${rows.length} of ${total}` : ""}</span></span>
        </div>
        {err && !rows && <ErrorState error={err} onRetry={load} />}
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {!rows && !err ? <div style={{ padding: 16 }}><Skeleton rows={6} /></div> : rows && (
            <table className="table">
              <thead><tr><th>Date</th><th>Developer</th><th>Start</th><th>End</th><th>Status</th><th className="num">Productive</th><th className="num">Presence</th><th className="num">Paused</th><th className="num">Tasks</th><th>Note</th><th></th></tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td>{s.session_date}</td>
                    <td><Avatar name={X.m2o(s.user_id)} id={s.user_id?.[0]} size={22} /> <b>{X.m2o(s.user_id)}</b></td>
                    <td>{X.local(s.login_at)}</td>
                    <td>{s.logout_at ? X.local(s.logout_at) : s.state === "open" ? <span className="mini">still working</span> : "—"}</td>
                    <td style={{ whiteSpace: "normal" }}>
                      {s.state === "open" ? <Lozenge tone={s.is_paused ? "paused" : "progress"}>{s.is_paused ? "Paused" : "Open"}</Lozenge> : <Lozenge tone="done">Closed</Lozenge>}
                      {s.auto_closed && <> <Lozenge tone="paused">Auto-closed</Lozenge></>}
                      {s.reverted && <div className="mini" style={{ color: "var(--pri-important)", fontWeight: 600 }}>↺ Reopened{s.reverted_by_id ? ` by ${X.m2o(s.reverted_by_id)}` : ""}{s.revert_reason ? ` — ${s.revert_reason}` : ""}</div>}
                    </td>
                    <td className="num">{X.hm(s.productive_seconds)}</td>
                    <td className="num">{X.hm(s.presence_seconds)}</td>
                    <td className="num">{s.paused_seconds ? X.hm(s.paused_seconds) : "—"}</td>
                    <td className="num">{s.task_count ?? "—"}</td>
                    <td style={{ whiteSpace: "normal", maxWidth: 260 }}><span className="mini">{s.note || ""}</span></td>
                    <td>{canReopen(s) && <Button size="sm" kind="ghost" onClick={() => reopen(s)}>Reopen</Button>}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={11} className="empty">No sessions in this filter.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
        {rows && rows.length < total && <Button kind="ghost" busy={more} onClick={loadMore} style={{ alignSelf: "center" }}>Load {Math.min(PAGE, total - rows.length)} more</Button>}
      </div>
    </>
  );
}
