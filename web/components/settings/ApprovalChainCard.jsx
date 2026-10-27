"use client";
import { useEffect, useState } from "react";
import { Button, Icon, Input, useDialogs, useFlags, Select } from "@/components/ui";
import { callKw } from "@/lib/api";

const M = "kpi.escalation.tier";

/* Who decides a new client request, in order (kpi.escalation.tier) — edited in
   place: step name, minutes, "task's manager", people (with the WhatsApp number
   their link goes to), order, add / delete. Same as the Odoo Configuration card. */
export default function ApprovalChainCard() {
  const flags = useFlags();
  const dlg = useDialogs();
  const [tiers, setTiers] = useState(null);
  const [staff, setStaff] = useState([]);
  const [saved, setSaved] = useState(0);

  const load = async () => {
    try {
      const [rows, users] = await Promise.all([
        callKw(M, "search_read", [[]], { fields: ["name", "sequence", "minutes", "use_task_manager", "user_ids"], order: "sequence, id" }),
        staff.length ? Promise.resolve(null) : callKw("res.users", "search_read", [[["share", "=", false]]], { fields: ["name", "kpi_wa_number", "kpi_mobile_number", "kpi_role"], order: "name" }),
      ]);
      if (users) /* Only admins / coordinators can decide; the rest are kept only to name them on a step. */
      setStaff(users.map((u) => ({ id: u.id, name: u.name, number: u.kpi_wa_number || u.kpi_mobile_number || "", canDecide: u.kpi_role === "admin" || u.kpi_role === "coordinator" })));
      setTiers(rows || []);
    } catch (e) { flags.err(e.message); setTiers([]); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const write = async (id, vals) => {
    try { await callKw(M, "write", [[id], vals]); setSaved(id); setTimeout(() => setSaved(0), 1500); await load(); }
    catch (e) { flags.err(e.message); }
  };
  const move = async (i, dir) => {
    const list = [...tiers]; const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    try { await Promise.all(list.map((t, k) => callKw(M, "write", [[t.id], { sequence: (k + 1) * 10 }]))); await load(); } catch (e) { flags.err(e.message); }
  };
  const add = async () => {
    const last = tiers?.[tiers.length - 1];
    try { await callKw(M, "create", [[{ name: "New step", minutes: 5, sequence: (last?.sequence || 0) + 10 }]]); await load(); } catch (e) { flags.err(e.message); }
  };
  const del = async (t) => {
    if (!(await dlg.confirm({ title: "Delete this step?", text: `"${t.name}" is removed from the approval chain.`, confirmLabel: "Delete", danger: true }))) return;
    try { await callKw(M, "unlink", [[t.id]]); await load(); } catch (e) { flags.err(e.message); }
  };
  const person = (id) => staff.find((u) => u.id === id) || { name: `#${id}`, number: "", canDecide: false };
  /* ⚠ The same person (or the task's manager) on two steps asks the same
     person twice: the later step adds nothing. Shown in red, not blocked. */
  const label = (j) => `step ${j + 1} · ${tiers[j].name}`;
  /* Only an explicit "Task's manager" tick counts: an empty step is a slot not filled yet. */
  const usesMgr = (t) => !!t.use_task_manager;
  const personDup = (i, id) => { const j = tiers.findIndex((t, k) => k !== i && t.user_ids.includes(id)); return j < 0 ? "" : label(j); };
  const mgrDup = (i) => { if (!usesMgr(tiers[i])) return ""; const j = tiers.findIndex((t, k) => k < i && usesMgr(t)); return j < 0 ? "" : label(j); };
  const nameDup = (i) => { const n = (tiers[i].name || "").trim().toLowerCase(); const j = tiers.findIndex((t, k) => k !== i && (t.name || "").trim().toLowerCase() === n); return j < 0 ? "" : label(j); };
  const anyDup = (tiers || []).some((t, i) => mgrDup(i) || nameDup(i) || t.user_ids.some((id) => personDup(i, id)));
  const RED = { border: "1px solid var(--danger)", background: "#fee2e2" };

  return (
    <div className="cardbox" id="approval-chain" style={{ scrollMarginTop: 72, gap: 10 }}>
      <h2 style={{ display: "flex", alignItems: "center" }}>Approval chain<span className="spacer" style={{ flex: 1 }} /><Button size="sm" icon="plus" onClick={add}>Add step</Button></h2>
      <span className="mini">A new client request, or a task a developer creates for themselves, goes to step 1. If nobody there decides within its minutes, the next step is asked, and so on. After the last step it keeps waiting and the last step is reminded every 30 minutes. <b>Nothing is accepted automatically.</b> Each person gets a private WhatsApp link on the number under their name.</span>
      {tiers === null && <span className="mini">Loading…</span>}
      {tiers && !tiers.length && <span className="mini">No steps — every manager is asked at once.</span>}
      {anyDup && <div role="alert" style={{ ...RED, borderRadius: 8, padding: "8px 10px", color: "var(--danger)", fontSize: 13, fontWeight: 600 }}>⚠ Some people are used on more than one step (marked in red). The same person asked twice adds nothing — put someone else on the later step.</div>}
      {(tiers || []).map((t, i) => (
        <div key={t.id} style={{ border: `1px solid ${mgrDup(i) || nameDup(i) ? "var(--danger)" : "var(--border)"}`, borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            <span className="chip-sm" style={{ background: "var(--hover)" }}>{i + 1}</span>
            <Input id={`tier-name-${t.id}`} defaultValue={t.name} style={{ maxWidth: 180, fontWeight: 700 }} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== t.name) write(t.id, { name: v }); }} />
            <Input id={`tier-min-${t.id}`} type="number" min={1} defaultValue={t.minutes} style={{ maxWidth: 110 }} right={<span className="mini">min</span>} onBlur={(e) => { const v = Math.max(1, parseInt(e.target.value, 10) || 1); if (v !== t.minutes) write(t.id, { minutes: v }); }} />
            <label className="chk" style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }} title="Also ask the task's own manager">
              <input type="checkbox" checked={!!t.use_task_manager} onChange={(e) => write(t.id, { use_task_manager: e.target.checked })} />Task's manager
            </label>
            {saved === t.id && <span className="mini" style={{ color: "var(--pri-regular)" }}>✓ saved</span>}
            {nameDup(i) && <span className="mini" style={{ color: "var(--danger)", fontWeight: 600 }}>⚠ Name already used for {nameDup(i)}</span>}
            <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              <button type="button" className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Icon n="up" size={16} /></button>
              <button type="button" className="icon-btn" aria-label="Move down" disabled={i === tiers.length - 1} onClick={() => move(i, 1)}><span style={{ display: "inline-flex", transform: "rotate(180deg)" }}><Icon n="up" size={16} /></span></button>
              <button type="button" className="icon-btn" aria-label="Delete step" onClick={() => del(t)} style={{ color: "var(--danger)" }}><Icon n="trash" size={16} /></button>
            </span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "stretch" }}>
            {t.user_ids.map((id) => { const u = person(id); const dup = personDup(i, id); return (
              <div key={id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "4px 8px", display: "flex", gap: 8, alignItems: "flex-start", background: "var(--hover)", ...(dup ? RED : {}) }}>
                <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.25 }}><b style={{ fontSize: 13 }}>{u.name}</b><span className="mini">{u.number || "no WhatsApp number"}</span>
                  {dup && <span className="mini" style={{ color: "var(--danger)", fontWeight: 600 }}>⚠ Already used for {dup}</span>}</span>
                <button type="button" className="icon-btn" style={{ width: 20, height: 20 }} aria-label={`Remove ${u.name}`} onClick={async () => { if (await dlg.confirm({ title: "Remove this person?", text: `${u.name} will no longer be asked at step "${t.name}".`, confirmLabel: "Remove", danger: true })) write(t.id, { user_ids: [[3, id]] }); }}><Icon n="x" size={12} /></button>
              </div>
            ); })}
            {(t.use_task_manager || !t.user_ids.length) && <div className="mini" style={{ border: "1px dashed var(--border)", borderRadius: 8, padding: "4px 8px", lineHeight: 1.25, ...(mgrDup(i) ? { ...RED, borderStyle: "dashed", color: "var(--danger)" } : {}) }}>{t.use_task_manager ? <>the task&apos;s manager<br />from the task</> : <>Nobody yet — add a person<br />until then it asks the task&apos;s manager</>}
              {mgrDup(i) && <><br /><b>⚠ Already used for {mgrDup(i)}</b></>}</div>}
            <span className="input" style={{ height: 32, maxWidth: 240, alignSelf: "center" }}>
              <Select value="" aria-label="Add person" onChange={(e) => { const id = +e.target.value; if (id) write(t.id, { user_ids: [[4, id]] }); }} style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", width: "100%" }}>
                <option value="">+ Add person…</option>
                {staff.filter((u) => !t.user_ids.includes(u.id)).map((u) => { const dup = personDup(i, u.id); return <option key={u.id} value={u.id} style={dup ? { color: "#dc2626" } : undefined}>{u.name}{u.number ? ` · ${u.number}` : ""}{dup ? ` — ⚠ already used for ${dup}` : ""}</option>; })}
              </Select>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
