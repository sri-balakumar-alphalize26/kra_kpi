"use client";
import { useEffect, useRef, useState } from "react";
import { Avatar, Button, ErrorState, Icon, Input, Lozenge, PageHeader, Skeleton, useDialogs, useFlags, Select } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import * as S from "@/lib/services/settings";
import SettingsNav from "./SettingsNav";

/* Company switches, each saved on change (the app auto-saves too). */
export default function Configuration() {
  const flags = useFlags();
  const cfg = useResource(S.CONFIG_PATH, {}, { ttl: 10000 });
  const devs = useResource(S.MULTITASK_PATH, {}, { ttl: 10000 });
  const dlg = useDialogs();
  const [events, setEvents] = useState(null);
  const [samples, setSamples] = useState({});
  const [saving, setSaving] = useState("");
  useEffect(() => { S.fetchGroupEvents().then((r) => { setEvents(r?.events || []); setSamples(r?.samples || {}); }).catch(() => setEvents([])); }, []);
  const refused = cfg.data?.status === false ? { message: cfg.data.message || cfg.data.error || "Could not load the configuration." } : null;
  const c = refused ? null : cfg.data;

  const save = async (key, fn, ok = "Saved.") => {
    setSaving(key);
    try { S.assertOk(await fn(), "Could not save."); flags.ok(ok); S.invalidateConfig(); cfg.refresh(); devs.refresh(); }
    catch (e) { flags.err(e.message); } finally { setSaving(""); }
  };
  /* One event's switch or wording (/kpi_wa_group/set_event); the answer is the saved state. */
  const saveEvent = (ev, vals, ok = "Saved.") => save(`e${ev.event}`, async () => {
    const r = S.assertOk(await S.setGroupEvent({ event: ev.event, ...vals }), "Could not save.");
    setEvents((es) => es.map((x) => (x.event === ev.event ? { ...x, enabled: r.enabled ?? x.enabled, template: r.template ?? x.template } : x)));
    return r;
  }, ok);
  const testEvent = async (ev) => {
    const jid = c.wa_group_jid, label = c.wa_group_name || jid;
    if (!(await dlg.confirm({ title: `Send a test "${ev.label || ev.event}" message?`, text: `It is posted to "${label}" (${jid}). Everyone in that group will see it. It is marked as a test.`, confirmLabel: "Send test" }))) return;
    save(`t${ev.event}`, () => S.testGroupEvent(ev.event, jid), "Test message sent.");
  };
  /* Daily report: Odoo stores the IST hour as a float (10.5 = 10:30). */
  const toTime = (h) => { const v = Number(h); if (!Number.isFinite(v)) return "10:00"; const H = Math.floor(v), M = Math.round((v - H) * 60); return `${String(H + Math.floor(M / 60)).padStart(2, "0")}:${String(M % 60).padStart(2, "0")}`; };
  const toHour = (t) => { const [H, M] = String(t || "10:00").split(":").map((x) => parseInt(x, 10) || 0); return H + M / 60; };
  const daily = (patch) => save("dr", () => S.cfgSet.dailyReport({ enabled: !!c.daily_report_enabled, hour: c.daily_report_hour ?? 10, coverage: c.daily_report_coverage || "yesterday", ...patch }));
  const Num = ({ k, value, suffix = "min", onSave, min = 0, width = 96 }) => {
    const [v, setV] = useState(value ?? "");
    useEffect(() => { setV(value ?? ""); }, [value]);
    return <span className="input" style={{ height: 30, width }}><input type="number" min={min} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { if (String(v) !== String(value ?? "")) onSave(+v); }} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit", textAlign: "right" }} /><span className="ph">{suffix}</span>{saving === k && <span className="spin" style={{ width: 12, height: 12, borderWidth: 2 }} />}</span>;
  };
  const Toggle = ({ on, onChange, k }) => <span className={`toggle ${on ? "on" : ""}`} role="switch" aria-checked={!!on} onClick={() => onChange(!on)} style={{ cursor: "pointer", opacity: saving === k ? .5 : 1 }} />;
  /* The retention routes accept days | months | years (anything else is saved as days). */
  const Ret = ({ k, number, unit, onSave }) => (
    <span style={{ display: "inline-flex", gap: 6 }}><Num k={k} value={number} suffix="" width={70} onSave={(n) => onSave(n, unit || "days")} /><span className="input" style={{ height: 30 }}><Select value={unit || "days"} onChange={(e) => onSave(number, e.target.value)} style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit" }}><option value="days">days</option><option value="months">months</option><option value="years">years</option></Select></span></span>
  );

  return (
    <>
      <PageHeader crumbs={[{ label: "Settings" }, { label: "Configuration" }]} title="Configuration">
        <span className="chip" style={{ background: "var(--lz-done-bg)", color: "var(--lz-done)" }}><Icon n="check" size={14} />{saving ? "Saving…" : "Changes save as you make them"}</span>
      </PageHeader>
      <SettingsNav />
      <div className="page">
        {(refused || (cfg.error && !c)) && <ErrorState error={refused || cfg.error} onRetry={cfg.refresh} />}
        {!c && !cfg.error && !refused && <div className="grid2"><div className="cardbox"><Skeleton rows={6} /></div><div className="cardbox"><Skeleton rows={6} /></div></div>}
        {c && (
          <>
            <div className="grid2">
              <div className="cardbox"><h2>Timers &amp; approvals</h2>
                <div className="kv"><span className="lbl">Admin accept window</span><span className="val">Self-created tasks wait for admin</span><span className="right"><Num k="aa" value={c.admin_accept_minutes} onSave={(v) => save("aa", () => S.cfgSet.adminAccept(v))} /></span></div>
                <div className="kv"><span className="lbl">Client approval</span><span className="val">Minutes the client has to approve before work is auto-released (minimum 1)</span><span className="right"><Num k="ca" min={1} value={c.client_approval_minutes} onSave={(v) => save("ca", () => S.cfgSet.clientApproval(v))} /></span></div>
                <div className="kv"><span className="lbl">Queue nudge</span><span className="val">Remind admins of unpublished requests</span><span className="right"><Num k="qn" value={c.queue_nudge_minutes} onSave={(v) => save("qn", () => S.cfgSet.queueNudge(v))} /></span></div>
                <div className="kv"><span className="lbl">Urgent nudge</span><span className="val">Ping the developer on an urgent pause</span><span className="right"><Num k="un" value={c.urgent_nudge_minutes} onSave={(v) => save("un", () => S.cfgSet.urgentNudge(v))} /></span></div>
                <div className="kv"><span className="lbl">Break alerts</span><span className="val">Break / lunch / meeting / budget</span><span className="right" style={{ gap: 4 }}>
                  <Num k="b1" value={c.break_alert_minutes} width={78} onSave={(v) => save("b1", () => S.cfgSet.breakAlerts({ break_alert_minutes: v, lunch_alert_minutes: c.lunch_alert_minutes, meeting_alert_minutes: c.meeting_alert_minutes, break_budget_minutes: c.break_budget_minutes }))} />
                  <Num k="b2" value={c.lunch_alert_minutes} width={78} onSave={(v) => save("b2", () => S.cfgSet.breakAlerts({ break_alert_minutes: c.break_alert_minutes, lunch_alert_minutes: v, meeting_alert_minutes: c.meeting_alert_minutes, break_budget_minutes: c.break_budget_minutes }))} />
                  <Num k="b3" value={c.meeting_alert_minutes} width={78} onSave={(v) => save("b3", () => S.cfgSet.breakAlerts({ break_alert_minutes: c.break_alert_minutes, lunch_alert_minutes: c.lunch_alert_minutes, meeting_alert_minutes: v, break_budget_minutes: c.break_budget_minutes }))} />
                  <Num k="b4" value={c.break_budget_minutes} width={78} onSave={(v) => save("b4", () => S.cfgSet.breakAlerts({ break_alert_minutes: c.break_alert_minutes, lunch_alert_minutes: c.lunch_alert_minutes, meeting_alert_minutes: c.meeting_alert_minutes, break_budget_minutes: v }))} /></span></div>
                <div className="kv"><span className="lbl">Standard workday</span><span className="val">Hours a full day should have</span><span className="right"><Num k="sh" value={c.standard_workday_hours} suffix="h" onSave={(v) => save("sh", () => S.cfgSet.standardHours(v))} /></span></div>
                <div className="kv"><span className="lbl">Country / dial code</span><span className="val">+{c.country_dial_code || c.phone_code || "91"} · {c.mobile_length || 10} digits</span><span className="right"><span className="input" style={{ height: 30 }}><Select value={c.country_id || ""} onChange={(e) => save("co", () => S.cfgSet.country(+e.target.value))} style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit" }}>{(c.countries || []).map((x) => <option key={x.id} value={x.id}>{x.name} (+{x.phone_code})</option>)}</Select></span></span></div>
                {/* Only a server with the attendance bridge module sends attendance_available. */}
                {c.attendance_available && <div className="kv" style={{ border: 0 }}><span className="lbl">Attendance in app</span><span className="val">Start Workday marks attendance</span><span className="right"><Toggle k="att" on={c.attendance_in_app} onChange={(v) => save("att", () => S.cfgSet.attendanceInApp(v))} /></span></div>}
              </div>
              <div className="cardbox"><h2>Daily report &amp; retention</h2>
                <div className="kv"><span className="lbl">Daily report</span><span className="val">Send the employee task report (PDF) to admins every day</span><span className="right"><Toggle k="dr" on={c.daily_report_enabled} onChange={(v) => daily({ enabled: v })} /></span></div>
                {c.daily_report_enabled && <div className="kv"><span className="lbl">Send at (IST)</span><span className="val">Previous day suits a morning send: everyone has ended their workday</span><span className="right" style={{ gap: 6 }}>
                  <TimeBox value={toTime(c.daily_report_hour)} onSave={(t) => daily({ hour: toHour(t) })} />
                  <span className="input" style={{ height: 30 }}><Select value={c.daily_report_coverage || "yesterday"} aria-label="Report covers" onChange={(e) => daily({ coverage: e.target.value })} style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit" }}><option value="yesterday">Previous day</option><option value="today">Same day</option></Select></span>
                </span></div>}
                <div className="kv"><span className="lbl">Workday snapshots</span><span className="val">Keep end-of-day images for</span><span className="right"><Ret k="sr" number={c.snapshot_retention_number} unit={c.snapshot_retention_unit} onSave={(n, u) => save("sr", () => S.cfgSet.snapshotRetention(n, u))} /></span></div>
                <div className="kv"><span className="lbl">Daily reports</span><span className="val">Keep PDFs for</span><span className="right"><Ret k="rr" number={c.report_retention_number} unit={c.report_retention_unit} onSave={(n, u) => save("rr", () => S.cfgSet.reportRetention(n, u))} /></span></div>
                <div className="kv"><span className="lbl">Report downloads</span><span className="val">Keep generated KRA report files for (0 = forever)</span><span className="right"><Ret k="dl" number={c.download_retention_number} unit={c.download_retention_unit} onSave={(n, u) => save("dl", () => S.cfgSet.downloadRetention(n, u))} /></span></div>
                <h2 style={{ marginTop: 10 }}>Developers · multitask &amp; WhatsApp</h2>
                {(devs.data?.developers || []).map((d) => (
                  <div key={d.id} className="kv" style={{ padding: "7px 0" }}><Avatar name={d.name} id={d.id} size={24} /><span className="val">{d.name}</span><span className="right"><WaField d={d} onSave={(v) => save(`wa${d.id}`, () => S.cfgSet.devWa(d.id, v))} /><Toggle k={`mt${d.id}`} on={d.allow_multitask} onChange={(v) => save(`mt${d.id}`, () => S.cfgSet.multitask(d.id, v))} /></span></div>
                ))}
                {devs.data && !(devs.data.developers || []).length && <span className="mini">No developers.</span>}
              </div>
            </div>
            <WaGroupCard selectedJid={c.wa_group_jid} selectedName={c.wa_group_name} flags={flags} onChanged={() => { S.invalidateConfig(); cfg.refresh(); }} />
            <div className="cardbox"><h2>WhatsApp group report <small>{c.wa_group_name ? `→ ${c.wa_group_name}` : c.wa_group_jid ? `→ ${c.wa_group_jid}` : "no group chosen yet (pick one above)"}</small></h2>
              {!events && <Skeleton rows={3} />}
              {events && !events.length && <span className="mini">No events available (WhatsApp module not connected).</span>}
              {events?.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {events.map((ev) => <EventCard key={ev.event} ev={ev} samples={samples} canTest={!!c.wa_group_jid} busy={saving === `e${ev.event}` || saving === `t${ev.event}`}
                    onToggle={() => saveEvent(ev, { enabled: !ev.enabled }, ev.enabled ? "Turned off." : "Turned on.")}
                    onSaveTemplate={(t) => saveEvent(ev, { template: t }, "Wording saved.")}
                    onReset={() => saveEvent(ev, { template: "" }, "Back to the default wording.")}
                    onTest={() => testEvent(ev)} />)}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

/* Which WhatsApp group the workday reports go to (/kpi_wa_group/*). Groups
   come from two places: ones a message was seen from (can be labelled) and
   the ones the connected number has joined (real names, member counts). A
   group needs a name before it can be chosen — an opaque id reads the same
   for the dev group and a client's. A test post must name the destination. */
function WaGroupCard({ selectedJid, selectedName, flags, onChanged }) {
  const dlg = useDialogs();
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const load = () => { setErr(""); return S.fetchWaGroups().then((r) => { if (r?.status === false) throw new Error(r.message || "Could not read the group list."); setData(r); }).catch((e) => { setErr(e.message); setData((d) => d || { groups: [] }); }); };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const jid = data?.selected_jid ?? selectedJid ?? "";
  const name = data?.selected_name ?? selectedName ?? "";
  const groups = data?.groups || [];

  const act = async (key, fn, ok) => {
    setBusy(key);
    try { const r = await fn(); S.assertOk(r, "Could not save."); flags.ok(r.message || ok); await load(); onChanged?.(); }
    catch (e) { flags.err(e.message); } finally { setBusy(""); }
  };
  const [q, setQ] = useState("");
  /* Naming the group is enforced on the button; this is the "are you sure" that names the destination. */
  const choose = async (g) => {
    if (!g.named) { flags.warn("Name the group first, so it is clear which one it is."); return; }
    if (!(await dlg.confirm({ title: "Send workday reports here?", text: `"${g.name}"${g.members ? ` (${g.members} members)` : ""} · ${g.jid}. Everyone in that group will see every workday start and end message.`, confirmLabel: "Use this group" }))) return;
    act(`s${g.jid}`, () => S.selectWaGroup(g.jid, g.name), `Reports will go to ${g.name}.`);
  };
  const ql = q.trim().toLowerCase();
  const shownGroups = ql ? (data?.groups || []).filter((g) => (g.name || "").toLowerCase().includes(ql) || (g.jid || "").toLowerCase().includes(ql)) : (data?.groups || []);
  const clear = async () => {
    if (!(await dlg.confirm({ title: "Stop posting to the group?", text: `Workday reports will no longer be posted to ${name || jid}.`, confirmLabel: "Clear", danger: true }))) return;
    act("clear", () => S.selectWaGroup("", ""), "Group cleared.");
  };
  const rename = async (g) => {
    const v = await dlg.form({ title: "Name this group", text: `A label so you can tell which group ${g.jid} is. Only used here.`, fields: [{ key: "name", label: "Name", value: g.name || "" }], confirmLabel: "Save" });
    if (!v) return;
    act(`r${g.jid}`, () => S.renameWaGroup(g.jid, v.name), "Group renamed.");
  };
  const test = async () => {
    if (!(await dlg.confirm({ title: "Send a test message?", text: `A test line is posted to "${name || "(unnamed)"}" (${jid}). Everyone in that group will see it.`, confirmLabel: "Send test" }))) return;
    act("test", () => S.testWaGroup(jid), "Test message dispatched.");
  };

  return (
    <div className="cardbox">
      <h2>WhatsApp report group <small>{jid ? `→ ${name || jid}` : "none chosen"}</small>
        <span className="right">
          {jid && <Button size="sm" busy={busy === "test"} onClick={test}>Send test</Button>}
          {jid && <Button size="sm" kind="ghost" busy={busy === "clear"} onClick={clear}>Clear</Button>}
          <Button size="sm" kind="ghost" icon="swap" onClick={() => { setData(null); load(); }}>Refresh</Button>
        </span>
      </h2>
      {err && <span className="mini" style={{ color: "var(--danger)" }}>{err}</span>}
      {!data && <Skeleton rows={3} />}
      {data && !groups.length && !err && <span className="mini">No groups yet. Add the company WhatsApp number to the group and have anyone post a message there — it then appears here.</span>}
      {groups.length > 8 && <Input icon="search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter groups by name or id…" aria-label="Filter groups" style={{ maxWidth: 360 }} />}
      {groups.length > 0 && (
        <div className="table-scroll" style={{ maxHeight: 320 }}>
          <table className="table">
            <thead><tr><th>Group</th><th className="num">Members</th><th className="num">Messages</th><th>Last seen</th><th></th></tr></thead>
            <tbody>
              {!shownGroups.length && <tr><td colSpan={5} className="empty">No group matches "{q}".</td></tr>}
              {shownGroups.map((g) => {
                const on = g.jid === jid;
                return (
                  <tr key={g.jid} className={on ? "sel" : ""}>
                    <td style={{ whiteSpace: "normal" }}>
                      {g.named ? <b>{g.name}</b> : <span className="mini">Unnamed group</span>}
                      {on && <> <Lozenge tone="done">Selected</Lozenge></>}
                      {g.joined && <> <Lozenge tone="neutral" style={{ textTransform: "none" }}>joined</Lozenge></>}
                      <div className="mini" style={{ marginTop: 2 }}>{g.jid}{g.last_sender ? ` · last from ${g.last_sender}` : ""}</div>
                    </td>
                    <td className="num">{g.members || "—"}</td>
                    <td className="num">{g.messages || 0}</td>
                    <td className="mini">{g.last_seen || "—"}</td>
                    <td><span style={{ display: "inline-flex", gap: 6 }}>
                      {g.seen && <Button size="sm" kind="ghost" busy={busy === `r${g.jid}`} onClick={() => rename(g)}>{g.named ? "Rename" : "Name it"}</Button>}
                      {!on && <Button size="sm" kind="primary" disabled={!g.named} title={g.named ? undefined : "Name the group first"} busy={busy === `s${g.jid}`} onClick={() => choose(g)}>Use this group</Button>}
                    </span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* One group-report event (Odoo kpi_configuration.js): on/off, a live preview
   with the sample values filled in, the editable wording (saved when the box
   loses focus), insert buttons for its tokens, reset, and its own test. */
function EventCard({ ev, samples, canTest, busy, onToggle, onSaveTemplate, onReset, onTest }) {
  const [tpl, setTpl] = useState(ev.template || "");
  const ref = useRef(null);
  useEffect(() => { setTpl(ev.template || ""); }, [ev.template]);
  const insert = (tok) => {
    const el = ref.current, tag = `{${tok}}`;
    const start = el ? el.selectionStart ?? tpl.length : tpl.length, end = el ? el.selectionEnd ?? tpl.length : tpl.length;
    const next = tpl.slice(0, start) + tag + tpl.slice(end);
    setTpl(next); onSaveTemplate(next);
    requestAnimationFrame(() => { if (el) { el.focus(); el.selectionStart = el.selectionEnd = start + tag.length; } });
  };
  return (
    <div className="cardbox" style={{ boxShadow: "none", padding: 12, gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className={`toggle ${ev.enabled ? "on" : ""}`} role="switch" aria-checked={!!ev.enabled} aria-label={ev.label || ev.event} tabIndex={0} onClick={onToggle} onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); onToggle(); } }} style={{ cursor: "pointer", opacity: busy ? .5 : 1 }} />
        <b>{ev.label || ev.event}</b><span className="mini">{ev.help || ""}</span>
        <span style={{ marginLeft: "auto" }}><Button size="sm" kind="ghost" onClick={onTest} disabled={!canTest} title={canTest ? undefined : "Choose a group first"}>Send test</Button></span>
      </div>
      {ev.enabled && <>
        <span className="mini">Preview: what the group sees</span>
        <div className="wa-bubble" style={{ whiteSpace: "pre-wrap", maxWidth: 460 }}>{waPreview(tpl, samples)}</div>
        {(ev.tokens || []).length > 0 && <span className="pillset" style={{ alignItems: "center" }}><span className="mini">Insert:</span>{ev.tokens.map((t) => <button key={t} type="button" className="pill" style={{ height: 24, fontSize: 11.5 }} onClick={() => insert(t)}>{t}</button>)}</span>}
        <span className="input ta" style={{ height: "auto" }}><textarea ref={ref} rows={4} value={tpl} aria-label={`Wording for ${ev.label || ev.event}`} onChange={(e) => setTpl(e.target.value)} onBlur={() => { if (tpl !== (ev.template || "")) onSaveTemplate(tpl); }} style={{ border: 0, background: "none", outline: 0, resize: "vertical", width: "100%", font: "inherit", color: "inherit" }} /></span>
        <span className="row" style={{ alignItems: "center" }}><Button size="sm" kind="ghost" icon="swap" onClick={onReset}>Reset to default</Button><span className="mini">Write it in plain words. Names, times and task details are filled in automatically.</span></span>
      </>}
    </div>
  );
}

/* The server's rule, mirrored: each {token} gets its sample value, and a line
   whose tokens ALL came out empty is dropped. *text* shows as bold. */
function waPreview(tpl, samples) {
  const lines = [];
  for (const line of String(tpl || "").split("\n")) {
    let filled = line; const got = [];
    for (const [k, v] of Object.entries(samples || {})) {
      const tok = `{${k}}`;
      if (filled.includes(tok)) { const val = v == null ? "" : String(v); got.push(val.trim()); filled = filled.split(tok).join(val); }
    }
    if (got.length && !got.some(Boolean)) continue;
    lines.push(filled);
  }
  return lines.join("\n").trim().split(/(\*[^*\n]+\*)/g).map((part, i) => (/^\*[^*\n]+\*$/.test(part) ? <b key={i}>{part.slice(1, -1)}</b> : part));
}

/* HH:MM, saved when changed. */
function TimeBox({ value, onSave }) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  return <span className="input" style={{ height: 30, width: 120 }}><input type="time" value={v} aria-label="Send time" onChange={(e) => setV(e.target.value)} onBlur={() => { if (v && v !== value) onSave(v); }} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }} /></span>;
}

/* Odoo stores the number normalized as bare <dial><local> digits
   (normalize_wa), so the dial code is shown once, as the prefix, and the
   field holds the local part. Saving the local part re-adds the dial code. */
function localWa(num, dial, len) {
  const n = String(num || "").replace(/\D/g, ""), dc = String(dial || "").replace(/\D/g, "") || "91";
  return n.startsWith(dc) && n.length === dc.length + (Number(len) || 10) ? n.slice(dc.length) : n;
}
function WaField({ d, onSave }) {
  const shown = localWa(d.wa_number, d.dial, d.mobile_length);
  const [v, setV] = useState(shown);
  useEffect(() => { setV(shown); }, [shown]);
  return <span className="input" style={{ height: 30, width: 170 }}><span className="ph">+{String(d.dial || "").replace(/\D/g, "") || "91"}</span><input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v !== shown) onSave(v); }} placeholder="WhatsApp number" style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }} /></span>;
}
