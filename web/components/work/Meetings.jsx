"use client";
/* My Work › Meetings — Odoo's Meetings menu (kpi.meeting), asked for on
   WhatsApp. A request arrives with NOBODY assigned: confirming means setting
   the time, saying who joins and pressing Confirm & send link, which posts the
   link into the client's group. Same buttons as the Odoo form header:
   Confirm & send link → Open now → Finished → Send summary, plus Cancel.
   Meeting time is shown as its own figure and is never added to task time
   (see kpi_meeting.py, actual_minutes). Developers see the list and the
   details; the buttons and edits are for admins, as on the web's other
   admin screens. */
import { useCallback, useEffect, useState } from "react";
import { Avatar, Button, Empty, ErrorState, Field, Input, Lozenge, Modal, PageHeader, Select, Skeleton, useDialogs, useFlags } from "@/components/ui";
import { useMe, isAdmin } from "@/lib/me";
import { fetchUsers } from "@/lib/services/kpiActions";
import { local, m2o } from "@/lib/services/sysadmin";
import * as M from "@/lib/services/meetings";

const when = (ts) => local(ts, { date: true });
const TA = { border: 0, background: "none", outline: 0, resize: "vertical", width: "100%", font: "inherit", color: "inherit" };

export default function Meetings() {
  const { me } = useMe();
  const [filter, setFilter] = useState("requested");
  const [mine, setMine] = useState(false);
  const [rows, setRows] = useState(null);
  const [counts, setCounts] = useState({});
  const [err, setErr] = useState(null);
  const [openId, setOpenId] = useState(null);

  const domainFor = useCallback((key) => {
    const d = [...(M.FILTERS.find((f) => f.key === key)?.domain || [])];
    if (mine) d.push(["organizer_id", "=", me.uid]);
    return d;
  }, [mine, me.uid]);

  const load = useCallback(async () => {
    try {
      const [r, ...n] = await Promise.all([M.listMeetings(domainFor(filter)), ...M.FILTERS.map((f) => M.countMeetings(domainFor(f.key)))]);
      setRows(r || []); setCounts(Object.fromEntries(M.FILTERS.map((f, i) => [f.key, n[i] || 0]))); setErr(null);
    } catch (e) { setErr(e); }
  }, [filter, domainFor]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <PageHeader crumbs={[{ label: "My Work" }, { label: "Meetings" }]} title="Meetings" meta="Asked for on WhatsApp. Confirm one to send the client its link.">
        <div className="tabs">
          {M.FILTERS.map((f) => (
            <span key={f.key} className={filter === f.key ? "on" : ""} onClick={() => setFilter(f.key)} style={{ cursor: "pointer" }}>
              {f.label}{counts[f.key] ? <em>{counts[f.key]}</em> : null}
            </span>
          ))}
        </div>
      </PageHeader>
      <div className="page">
        <div className="toolbar">
          <label className="row mini" style={{ cursor: "pointer" }}><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only meetings I join</label>
          <span className="right"><Button size="sm" kind="ghost" onClick={load}>Refresh</Button></span>
        </div>
        {err && !rows && <ErrorState error={err} onRetry={load} />}
        {!rows && !err && <div className="cardbox"><Skeleton rows={6} /></div>}
        {rows && !rows.length && (
          <Empty icon="inbox" title={filter === "requested" ? "No meetings waiting" : "No meetings here"}
            text="A client taps Request a Meeting on WhatsApp and picks a time. It arrives here with nobody assigned." />
        )}
        {rows && !!rows.length && (
          <div className="cardbox table-scroll" style={{ padding: 0 }}>
            <table className="table">
              <thead><tr><th>Starts</th><th>Subject</th><th>Client</th><th>Who joins</th><th>Asked by</th><th>Status</th><th className="num">Ran for</th></tr></thead>
              <tbody>
                {rows.map((m) => {
                  const [tone, label] = M.STATES[m.state] || ["todo", m.state];
                  return (
                    <tr key={m.id} onClick={() => setOpenId(m.id)} style={{ cursor: "pointer" }}>
                      <td>{m.scheduled_start ? when(m.scheduled_start) : <span className="mini" title={m.requested_text || ""}>Asked: {m.requested_text || "no time yet"}</span>}</td>
                      <td style={{ whiteSpace: "normal", maxWidth: 320 }}><b>{m.name}</b>{m.is_internal && <Lozenge tone="neutral" style={{ marginLeft: 6, textTransform: "none" }} title="A developer and the manager only — no client">Internal</Lozenge>}{m.kpi_id && <div className="mini">{m2o(m.kpi_id)}</div>}</td>
                      <td>{m2o(m.client_kra_id) || "—"}</td>
                      <td>{m.organizer_id ? <><Avatar name={m2o(m.organizer_id)} uid={m.organizer_id[0]} size={22} /> {m2o(m.organizer_id)}</> : <span className="mini" style={{ color: "var(--pri-important)", fontWeight: 700 }}>Nobody yet</span>}</td>
                      <td>{m.requested_by_name || "—"}</td>
                      <td><Lozenge tone={tone}>{label}</Lozenge></td>
                      <td className="num">{m.actual_minutes ? `${m.actual_minutes} min` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {openId && <MeetingDialog id={openId} canEdit={isAdmin(me)} onClose={() => setOpenId(null)} onChanged={load} />}
    </>
  );
}

function MeetingDialog({ id, canEdit, onClose, onChanged }) {
  const flags = useFlags();
  const dlg = useDialogs();
  const [m, setM] = useState(null);
  const [draft, setDraft] = useState({});
  const [people, setPeople] = useState([]);
  const [users, setUsers] = useState([]);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await M.readMeeting(id);
      if (!r) throw new Error("This meeting no longer exists.");
      setM(r);
      setDraft({ name: r.name || "", start: M.toLocalInput(r.scheduled_start), minutes: r.duration_minutes || 30,
        organizer: r.organizer_id ? String(r.organizer_id[0]) : "", attendees: r.attendee_user_ids || [],
        provider: r.provider || "jitsi", join_url: r.join_url || "", summary: r.summary || "", action_items: r.action_items || "", notes: r.notes || "" });
      setPeople(await M.listParticipants(id).catch(() => []));
      if (["confirmed", "live", "done"].includes(r.state)) setLink(await M.clientLink(id).catch(() => r.join_url || ""));
      setErr(null);
    } catch (e) { setErr(e); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (canEdit) fetchUsers().then((u) => setUsers(u || [])).catch(() => {}); }, [canEdit]);

  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e?.target ? e.target.value : e }));
  const changes = () => {
    if (!m) return {};
    const v = {};
    if (draft.name.trim() && draft.name.trim() !== m.name) v.name = draft.name.trim();
    const start = M.fromLocalInput(draft.start);
    if ((start || false) !== (m.scheduled_start || false)) v.scheduled_start = start;
    if (Number(draft.minutes) !== m.duration_minutes) v.duration_minutes = Math.max(5, Number(draft.minutes) || 30);
    const org = draft.organizer ? Number(draft.organizer) : false;
    if (org !== (m.organizer_id ? m.organizer_id[0] : false)) v.organizer_id = org;
    const att = [...draft.attendees].sort().join(","), was = [...(m.attendee_user_ids || [])].sort().join(",");
    if (att !== was) v.attendee_user_ids = [[6, 0, draft.attendees]];
    if (draft.provider !== m.provider) v.provider = draft.provider;
    if (draft.provider === "manual" && draft.join_url !== (m.join_url || "")) v.join_url = draft.join_url.trim();
    for (const k of ["summary", "action_items", "notes"]) if (draft[k] !== (m[k] || "")) v[k] = draft[k];
    return v;
  };
  const dirty = Object.keys(changes()).length > 0;

  /* Save first (the Odoo form does too), then press the button. */
  const run = async (key, fn, okText) => {
    setBusy(key);
    try {
      const v = changes();
      if (Object.keys(v).length) await M.writeMeeting(id, v);
      if (fn) await fn(id);
      flags.ok(okText);
      await load(); onChanged?.();
    } catch (e) { flags.err(e.message); } finally { setBusy(""); }
  };
  const cancel = async () => {
    const v = await dlg.form({ title: "Cancel this meeting?", confirmLabel: "Cancel meeting",
      text: "The client is told in their WhatsApp group, with your reason.",
      fields: [{ key: "reason", label: "Reason (sent to the client)", value: "", required: false, placeholder: "We will be in touch to rearrange." }] });
    if (!v) return;
    setBusy("cancel");
    try { await M.cancelMeeting(id, v.reason.trim()); flags.ok("Meeting cancelled. The client has been told."); await load(); onChanged?.(); }
    catch (e) { flags.err(e.message); } finally { setBusy(""); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(link); flags.ok("Link copied."); } catch { flags.err("Could not copy."); } };

  const st = m?.state;
  const edit = canEdit && st && !["done", "cancelled"].includes(st);
  const [tone, label] = (st && M.STATES[st]) || ["todo", ""];
  const footer = m && canEdit && (
    <>
      {!["done", "cancelled"].includes(st) && <Button kind="ghost" busy={busy === "cancel"} onClick={cancel} style={{ marginRight: "auto" }}>Cancel meeting</Button>}
      {dirty && <Button busy={busy === "save"} onClick={() => run("save", null, "Saved.")}>Save</Button>}
      {(st === "requested" || st === "confirmed") && <Button kind="primary" busy={busy === "confirm"} onClick={() => run("confirm", M.confirmMeeting, "Confirmed. The link is posted in the client's group.")}>{st === "confirmed" ? "Re-send link" : "Confirm & send link"}</Button>}
      {st === "confirmed" && <Button busy={busy === "open"} onClick={() => run("open", M.openNow, "The link is posted now.")}>Open now</Button>}
      {st === "live" && <Button kind="primary" busy={busy === "done"} onClick={() => run("done", M.markDone, "Finished. The clock has stopped.")}>Finished</Button>}
      {st === "done" && !m.summary_posted && <Button kind="primary" busy={busy === "summary"} disabled={!draft.summary.trim()} onClick={() => run("summary", M.postSummary, "Summary sent to the client.")}>Send summary</Button>}
    </>
  );

  return (
    <Modal open onClose={onClose} width={760} footer={footer}
      title={<span className="row" style={{ gap: 10 }}>{m ? m.name : "Meeting"}{st && <Lozenge tone={tone}>{label}</Lozenge>}</span>}>
      {err && <ErrorState error={err} onRetry={load} />}
      {!m && !err && <Skeleton rows={8} />}
      {m && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="mini">{m2o(m.kpi_id)}{m.client_kra_id ? ` · ${m2o(m.client_kra_id)}` : ""}{m.client_db_id ? ` · ${m2o(m.client_db_id)}` : ""}</div>

          {st === "requested" && (
            <div className="cardbox" style={{ background: "var(--lz-paused-bg)", boxShadow: "none" }}>
              <b>Not confirmed.</b> The client has asked for this and hasn't been told anything yet. Set the time, say who will join, then press <b>Confirm &amp; send link</b>.
              {m.requested_text && <div>They asked for <b>“{m.requested_text}”</b> in their own words. Set a real start time below.</div>}
            </div>
          )}

          <div className="grid2">
            <Field label="Subject">{edit ? <Input value={draft.name} onChange={set("name")} /> : <div>{m.name}</div>}</Field>
            <Field label="Asked by" hint={m.requested_by_number || undefined}><div>{m.requested_by_name || "—"}</div></Field>
            <Field label="Starts" hint={m.local_when || "Shown to the client in India and Gulf time."}>
              {edit ? <Input type="datetime-local" value={draft.start} onChange={set("start")} /> : <div>{m.scheduled_start ? when(m.scheduled_start) : "Not set"}</div>}
            </Field>
            <Field label="Minutes">{edit ? <Input type="number" min={5} step={5} value={draft.minutes} onChange={set("minutes")} /> : <div>{m.duration_minutes} min</div>}</Field>
            <Field label="Who will join" hint="Named to the client when the link goes out.">
              {edit
                ? <span className="input"><Select value={draft.organizer} onChange={set("organizer")} placeholder="Pick a person" style={{ border: 0, background: "none", width: "100%" }}>
                    <option value="">Nobody yet</option>{users.map((u) => <option key={u.id} value={String(u.id)}>{u.name}</option>)}
                  </Select></span>
                : <div>{m2o(m.organizer_id) || "Nobody yet"}</div>}
            </Field>
            <Field label="Where">
              {edit
                ? <span className="input"><Select value={draft.provider} onChange={set("provider")} style={{ border: 0, background: "none", width: "100%" }}>
                    <option value="jitsi">Jitsi (no account needed)</option><option value="manual">A link I will paste</option>
                  </Select></span>
                : <div>{m.provider === "manual" ? "Pasted link" : "Jitsi"}</div>}
            </Field>
          </div>

          {edit && users.length > 0 && (
            <Field label="Also joining">
              <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                {users.map((u) => {
                  const on = draft.attendees.includes(u.id);
                  return <Button key={u.id} size="sm" kind={on ? "primary" : "ghost"} onClick={() => setDraft((d) => ({ ...d, attendees: on ? d.attendees.filter((x) => x !== u.id) : [...d.attendees, u.id] }))}>{u.name}</Button>;
                })}
              </div>
            </Field>
          )}
          {edit && draft.provider === "manual" && (
            <Field label="Meeting link"><Input value={draft.join_url} onChange={set("join_url")} placeholder="https://…" /></Field>
          )}

          {link && (
            <Field label="Client link" hint="The page the client opens. It records who joined and when, so don't send the raw Jitsi room instead.">
              <div className="row"><Input value={link} readOnly /><Button size="sm" onClick={copy}>Copy</Button><a className="btn btn-ghost" style={{ height: 28, fontSize: 12.5 }} href={link} target="_blank" rel="noreferrer">Open</a></div>
            </Field>
          )}

          {["live", "done"].includes(st) && (
            <div className="cardbox" style={{ boxShadow: "none" }}>
              <h2>How long it ran<span className="right"><small>Kept apart from task time</small></span></h2>
              <div className="grid2">
                <Field label="Opened"><div>{when(m.opened_at)}</div></Field>
                <Field label="Finished"><div>{m.ended_at ? when(m.ended_at) : "Still open"}</div></Field>
              </div>
              {st === "done" && <div><b>{m.actual_minutes || 0} minutes</b> of meeting</div>}
            </div>
          )}

          {["confirmed", "live", "done"].includes(st) && (
            <div className="cardbox" style={{ boxShadow: "none", padding: 0 }}>
              <h2 style={{ padding: "12px 16px 0" }}>Who was in the room</h2>
              {people.length ? (
                <table className="table">
                  <thead><tr><th>Name (as they typed it)</th><th>Joined</th><th>Left</th><th className="num">Minutes</th></tr></thead>
                  <tbody>{people.map((p) => <tr key={p.id}><td><b>{p.person_name || "—"}</b></td><td>{when(p.joined_at)}</td><td>{p.left_at ? when(p.left_at) : "still in"}</td><td className="num">{p.minutes || 0}</td></tr>)}</tbody>
                </table>
              ) : <p className="mini" style={{ padding: "0 16px 12px", margin: 0 }}>Nobody recorded yet. Names and times are captured only when people join through the client link above.</p>}
            </div>
          )}

          {st === "done" && (
            <>
              <Field label="Summary" required hint={m.summary_posted ? "Sent to the client." : "What was agreed. This is what gets sent to the client."}>
                <span className="input ta" style={{ height: "auto" }}><textarea rows={4} value={draft.summary} readOnly={!canEdit} onChange={set("summary")} style={TA} /></span>
              </Field>
              <Field label="Next steps">
                <span className="input ta" style={{ height: "auto" }}><textarea rows={3} value={draft.action_items} readOnly={!canEdit} onChange={set("action_items")} placeholder="Who does what, by when." style={TA} /></span>
              </Field>
            </>
          )}

          {canEdit && (
            <Field label="Internal notes" hint="Never sent to the client.">
              <span className="input ta" style={{ height: "auto" }}><textarea rows={2} value={draft.notes} onChange={set("notes")} style={TA} /></span>
            </Field>
          )}
          {st === "cancelled" && m.cancel_reason && <div className="mini">Cancelled: {m.cancel_reason}</div>}
          {m.confirmed_by_id && <div className="mini">Confirmed by {m2o(m.confirmed_by_id)} · {when(m.confirmed_at)}{m.link_posted_at ? ` · link posted ${when(m.link_posted_at)}` : ""}{m.reminder_sent_at ? ` · reminder ${when(m.reminder_sent_at)}` : ""}</div>}
        </div>
      )}
    </Modal>
  );
}
