"use client";
import { useEffect, useMemo, useState } from "react";
import { Button, ErrorState, Field, Icon, IconButton, Input, Lozenge, PageHeader, Skeleton, useDialogs, useFlags, Select } from "@/components/ui";
import * as M from "@/lib/services/more";
import { useMe } from "@/lib/me";
import { getIntakeUsers } from "@/lib/services/admin";
import { fetchClientTree, parseServerTs, fmtLocalDateTime, localDay } from "@/lib/services/kpiActions";

/* next_trigger / completed_at come from search_read: UTC "YYYY-MM-DD HH:MM:SS". */
const utcLocal = (s) => fmtLocalDateTime(parseServerTs(s));

/* Reminders: table + edit form (kpi.reminder). Due ones ring in this tab as a
   flag; no OS alarms on the web. */
export default function Reminders() {
  const flags = useFlags();
  const dlg = useDialogs();
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState(null); /* null | {} new | row */
  /* null | { reminder: row|null (null = every reminder), rows: [] | null while loading, err } */
  const [history, setHistory] = useState(null);
  const [busy, setBusy] = useState(false);
  const [clients, setClients] = useState(null);
  const { me } = useMe();
  const system = !!me?.flags?.isSystem;
  const [users, setUsers] = useState([]);
  useEffect(() => { if (system) getIntakeUsers().then(setUsers).catch(() => {}); }, [system]);

  const load = () => M.fetchReminders(system).then((r) => { if (r.status) { setData(r.reminders); setErr(""); } else setErr(r.message || "Unavailable"); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); fetchClientTree().then(setClients).catch(() => setClients([])); }, [system]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Ring: when a reminder's next_trigger passes while this tab is open. */
  useEffect(() => {
    if (!data) return;
    const rung = new Set();
    const id = setInterval(() => {
      const now = Date.now();
      for (const r of data) {
        if (!r.enabled || !r.next_trigger || rung.has(r.id)) continue;
        const t = parseServerTs(r.next_trigger);
        if (t != null && t <= now && now - t < 10 * 60 * 1000) {
          rung.add(r.id);
          flags.warn(`⏰ ${r.name}`, { ttl: 0 });
          try { if (Notification?.permission === "granted") new Notification("KRA KPI reminder", { body: r.name }); } catch (_) {}
        }
      }
    }, 15000);
    return () => clearInterval(id);
  }, [data, flags]);

  /* Odoo: "a client or any KRA": the client itself first, then everything under it. */
  const projects = useMemo(() => (clients || []).flatMap((c) => [{ id: c.id, label: c.name }, ...c.projects.filter((p) => p.id !== c.id).map((p) => ({ id: p.id, label: `${c.name} › ${p.display}` }))]), [clients]);

  const save = async (e) => {
    e.preventDefault(); setBusy(true);
    try {
      const vals = { id: edit.id, name: edit.name, remind_date: edit.remind_date, remind_time: M.timeToFloat(edit.time), enabled: edit.enabled ?? true, repeat: edit.repeat || "none", kra_id: edit.kra_id || false, ...(system && edit.user_id ? { user_id: edit.user_id } : {}) };
      if (!vals.name?.trim()) throw new Error("Give the reminder a name.");
      if (!vals.remind_date) throw new Error("Pick a date.");
      await M.saveReminder(vals);
      flags.ok(edit.id ? "Reminder saved." : "Reminder added.");
      setEdit(null); load();
    } catch (ex) { flags.err(ex.message); } finally { setBusy(false); }
  };
  const del = async (r) => { if (!(await dlg.confirm({ title: "Delete reminder?", text: `"${r.name}" will be removed.`, confirmLabel: "Delete", danger: true }))) return; try { await M.deleteReminder(r.id); flags.ok("Deleted."); load(); } catch (ex) { flags.err(ex.message); } };
  const toggle = async (r) => { try { await M.saveReminder({ id: r.id, enabled: !r.enabled }); load(); } catch (ex) { flags.err(ex.message); } };
  const askPerm = () => { try { Notification.requestPermission(); } catch (_) {} };
  /* History: one reminder's own completions (Odoo's stat button → action_view_history,
     domain reminder_id = id), or every completion from the header button. */
  const showHistory = (r = null) => {
    setHistory({ reminder: r, rows: null, err: "" });
    M.fetchReminderHistory(r ? 200 : 100, r?.id).then((h) => setHistory((cur) => (cur && cur.reminder?.id === r?.id ? { reminder: r, rows: h.rows, err: h.status ? "" : (h.message || "Could not load the history.") } : cur)));
  };
  const done = async (r) => { try { await M.completeReminder(r.id); flags.ok("Marked done."); load(); if (history) showHistory(history.reminder); } catch (ex) { flags.err(ex.message); } };

  return (
    <>
      <PageHeader crumbs={[{ label: "Your work" }, { label: "Reminders" }]} title="Reminders" meta="Ring in this tab while it is open">
        {typeof Notification !== "undefined" && Notification.permission === "default" && <Button onClick={askPerm}>Allow browser notifications</Button>}
        <Button onClick={() => showHistory(null)}>History</Button>
        <Button kind="primary" icon="plus" onClick={() => setEdit({ name: "", remind_date: localDay(Date.now()), time: "09:30", repeat: "none", enabled: true, kra_id: "" })}>New reminder</Button>
      </PageHeader>
      <div className="pane" style={{ alignItems: "flex-start" }}>
        <div className="cardbox table-scroll" style={{ padding: 0, flex: 1 }}>
          {err && <div style={{ padding: 16 }}><ErrorState error={{ message: err }} onRetry={load} /></div>}
          {!data && !err && <div style={{ padding: 16 }}><Skeleton rows={4} /></div>}
          {data && (
            <table className="table">
              <thead><tr><th>Reminder</th><th>When</th><th>Repeat</th><th>Client / KRA</th><th>On</th><th></th></tr></thead>
              <tbody>
                {data.map((r) => {
                  const due = r.enabled && r.next_trigger && (parseServerTs(r.next_trigger) ?? Infinity) <= Date.now();
                  return (
                    <tr key={r.id} className={edit?.id === r.id ? "sel" : ""}>
                      <td><b>{r.name}</b>{due && <> <Lozenge tone="danger">Due</Lozenge></>}{r.completion_count > 0 && <> <button type="button" className="mini" onClick={() => showHistory(r)} title="This reminder's history" style={{ border: 0, background: "none", padding: 0, cursor: "pointer", color: "var(--brand)", font: "inherit", fontSize: 12 }}>· done {r.completion_count}×</button></>}</td>
                      <td>{r.remind_date} {M.floatToTime(r.remind_time)}{r.enabled && r.next_trigger ? <span className="mini"> · {due ? "was due" : "next"} {utcLocal(r.next_trigger)}</span> : null}</td>
                      <td>{M.REPEATS.find(([k]) => k === r.repeat)?.[1] || r.repeat}</td>
                      <td>{r.client_kra_id?.[1] || r.kra_id?.[1] || "—"}</td>
                      <td><span className={`toggle ${r.enabled ? "on" : ""}`} role="switch" aria-checked={r.enabled} onClick={() => toggle(r)} style={{ cursor: "pointer" }} /></td>
                      <td><span style={{ display: "inline-flex", gap: 2 }}>
                        <IconButton icon="check" label="Mark done" size={16} onClick={() => done(r)} />
                        <IconButton icon="clock" label="History" size={16} onClick={() => showHistory(r)} />
                        <IconButton icon="pen" label="Edit" size={16} onClick={() => setEdit({ ...r, time: M.floatToTime(r.remind_time), kra_id: r.kra_id?.[0] || "", user_id: r.user_id?.[0] || "" })} />
                        <IconButton icon="trash" label="Delete" size={16} onClick={() => del(r)} />
                      </span></td>
                    </tr>
                  );
                })}
                {!data.length && <tr><td colSpan={6} className="empty">No reminders yet. Add one on the right.</td></tr>}
              </tbody>
            </table>
          )}
          {history && (
            <div style={{ borderTop: "1px solid var(--border)", padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <h2 style={{ margin: 0, fontSize: 14, color: "var(--navy)", flex: 1 }}>{history.reminder ? `History — ${history.reminder.name}` : "Completed"}</h2>
                {history.reminder && <Button size="sm" kind="ghost" onClick={() => showHistory(null)}>All reminders</Button>}
                <IconButton icon="x" label="Close history" size={16} onClick={() => setHistory(null)} />
              </div>
              {history.err ? <ErrorState error={{ message: history.err }} onRetry={() => showHistory(history.reminder)} />
                : !history.rows ? <Skeleton rows={3} />
                : history.rows.length ? (
                  <table className="table">
                    {/* Odoo's Reminder History list: Reminder · Was Due · Completed At · Completed By */}
                    <thead><tr>{!history.reminder && <th>Reminder</th>}<th>Was due</th><th>Completed</th><th>Completed by</th></tr></thead>
                    <tbody>
                      {(history.reminder ? history.rows : history.rows.slice(0, 30)).map((h) => (
                        <tr key={h.id}>
                          {!history.reminder && <td><b>{h.name_snapshot}</b>{!h.reminder_id && <span className="mini"> · deleted</span>}</td>}
                          <td>{utcLocal(h.time_snapshot) || "—"}</td>
                          <td>{utcLocal(h.completed_at) || "—"}</td>
                          <td>{h.completed_by?.[1] || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <span className="mini">{history.reminder ? "This reminder has not been completed yet." : "Nothing completed yet."}</span>}
            </div>
          )}
        </div>
        {edit && (
          <form className="cardbox fixed" onSubmit={save}>
            <h2>{edit.id ? "Edit reminder" : "New reminder"}</h2>
            <Field label="Name" required><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus /></Field>
            <div className="grid2">
              <Field label="Date" required><Input type="date" value={edit.remind_date || ""} onChange={(e) => setEdit({ ...edit, remind_date: e.target.value })} /></Field>
              <Field label="Time"><Input type="time" value={edit.time || "09:30"} onChange={(e) => setEdit({ ...edit, time: e.target.value })} /></Field>
            </div>
            <Field label="Repeat"><span className="input"><Select value={edit.repeat || "none"} onChange={(e) => setEdit({ ...edit, repeat: e.target.value })} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}>{M.REPEATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></span></Field>
            {system && <Field label="Owner" hint="Whose reminder this is"><span className="input"><Select value={String(edit.user_id || me?.uid || "")} onChange={(e) => setEdit({ ...edit, user_id: e.target.value })} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></span></Field>}
            <Field label="Client / project (optional)"><span className="input"><Select value={edit.kra_id || ""} onChange={(e) => setEdit({ ...edit, kra_id: e.target.value })} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}><option value="">—</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</Select></span></Field>
            <label className="chk"><input type="checkbox" checked={edit.enabled ?? true} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} style={{ width: 16, height: 16, accentColor: "var(--brand)" }} />Enabled</label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}><Button kind="ghost" type="button" onClick={() => setEdit(null)}>Cancel</Button><Button kind="primary" type="submit" busy={busy}>Save</Button></div>
          </form>
        )}
      </div>
    </>
  );
}
