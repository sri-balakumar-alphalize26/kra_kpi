"use client";
import { useMemo, useState } from "react";
import { Button, ErrorState, Input, Lozenge, PageHeader, Select, Skeleton, StaleBar, useFlags } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import { invalidate } from "@/lib/api";
import * as L from "@/lib/services/legacy";
import { VoiceNotes } from "@/components/task/Legacy";
import { useTaskActions } from "@/components/task/TaskActions";

/* Needs linking: bugs / updates raised "From old DB" that still wait for the
   old requirement's Request ID (/kra_kpi/legacy/pending, oldest first),
   grouped by client. Link saves the Request ID (and a name) on the task, which
   renumbers it under that requirement and marks it Confirmed with client, so
   it leaves this list. */
export default function NeedsLinking() {
  const flags = useFlags();
  const acts = useTaskActions();
  const res = useResource(L.PENDING_PATH, {}, { pollMs: 60000, ttl: 10000 });
  const err = res.data?.status === false ? { message: res.data.message || "Could not load the list." } : res.error;
  const tasks = (res.data?.status === false ? null : res.data?.tasks) || [];
  const [client, setClient] = useState("");
  const [link, setLink] = useState({}); /* task id → {ref, name} being typed */
  const [busy, setBusy] = useState(0);

  const clients = useMemo(() => {
    const m = new Map();
    for (const t of tasks) m.set(String(t.client_id || ""), t.client || "—");
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [tasks]);
  const groups = useMemo(() => {
    const m = new Map();
    for (const t of tasks) {
      const k = String(t.client_id || "");
      if (client && k !== client) continue;
      if (!m.has(k)) m.set(k, { client: t.client || "—", rows: [] });
      m.get(k).rows.push(t);
    }
    return [...m.values()].sort((a, b) => a.client.localeCompare(b.client));
  }, [tasks, client]);
  const refresh = () => { invalidate(L.PENDING_PATH); res.refresh(); };

  const save = async (t) => {
    const l = link[t.id] || {};
    const ref = L.normalizeRef((l.ref || "").trim());
    if (!ref) { flags.err("Type the Request ID, e.g. REQ-012."); return; }
    setBusy(t.id);
    try {
      /* The message stays as it is; an empty name keeps the one the client gave. */
      const r = await L.saveLegacy(t.id, { ref, name: (l.name || "").trim() || t.legacy_name, note: t.note });
      if (!r?.status) { flags.err(r?.message || "Could not link it."); return; }
      flags.ok(`${t.ref || "Task"} linked${r.ref ? ` — now ${r.ref}` : ""}.`);
      setLink((x) => { const n = { ...x }; delete n[t.id]; return n; });
      refresh();
    } catch (e) { flags.err(e.message); } finally { setBusy(0); }
  };
  const field = { border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" };

  return (
    <>
      <PageHeader crumbs={[{ label: "Work" }, { label: "Client task queue", href: "/queue" }, { label: "Needs linking" }]} title="Needs linking" meta="Bugs and updates about an old-DB requirement, waiting for its Request ID">
        {res.data && !err && <span className="chip">{tasks.length} waiting</span>}
        {clients.length > 1 && <span className="input" style={{ height: 32, width: 220 }}><Select value={client} onChange={(e) => setClient(e.target.value)} style={field}><option value="">All clients</option>{clients.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select></span>}
      </PageHeader>
      <div className="page">
        {err && (!res.data || res.data.status === false) && <ErrorState error={err} onRetry={res.refresh} />}
        {res.stale && res.data?.status !== false && <StaleBar error={res.error} onRetry={res.refresh} />}
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {!res.data && !err ? <div style={{ padding: 16 }}><Skeleton rows={5} /></div> : res.data?.status === false || !res.data ? null : (
            <table className="table">
              <thead><tr><th>Ref</th><th style={{ width: "34%" }}>Request</th><th>Database</th><th>Raised</th><th style={{ width: 300 }}>Link to the old requirement</th></tr></thead>
              <tbody>
                {groups.map((g) => (
                  <GroupRows key={g.client} g={g} link={link} setLink={setLink} busy={busy} onSave={save} onOpen={acts ? (id) => acts.openTask(id) : null} />
                ))}
                {!tasks.length && <tr><td colSpan={5} className="empty">Nothing to link. Every old-DB bug and update has its Request ID.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function GroupRows({ g, link, setLink, busy, onSave, onOpen }) {
  const upd = (id, patch) => setLink((x) => ({ ...x, [id]: { ...(x[id] || {}), ...patch } }));
  return (
    <>
      <tr className="group"><td colSpan={5}>{g.client} · {g.rows.length} waiting</td></tr>
      {g.rows.map((t) => {
        const l = link[t.id] || {};
        return (
          <tr key={t.id} style={{ verticalAlign: "top" }}>
            <td>
              <span className="ref">{t.ref || `#${t.id}`}</span>
              <div style={{ marginTop: 4 }}><Lozenge tone="paused" style={{ textTransform: "none" }}>Pending</Lozenge></div>
            </td>
            <td style={{ whiteSpace: "normal" }}>
              <b>{t.name}</b>
              {onOpen && <button className="btn" style={{ height: 24, fontSize: 11.5, marginLeft: 8 }} onClick={() => onOpen(t.id)}>Open task</button>}
              {t.legacy_name && <div className="mini" style={{ marginTop: 4 }}>Old task: <b>{t.legacy_name}</b></div>}
              {t.note && <p style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{t.note}</p>}
              {t.transcript && <p className="mini" style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}><b>Transcript:</b> {t.transcript}</p>}
              {t.voice_notes?.length > 0 && <div style={{ marginTop: 6 }}><VoiceNotes notes={t.voice_notes} /></div>}
            </td>
            <td>{t.db || <span className="mini">—</span>}</td>
            <td><span className="mini">{t.by || "—"}{t.date ? <><br />{t.date}</> : null}</span></td>
            <td>
              <span style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <Input value={l.ref || ""} aria-label="Request ID" onChange={(e) => upd(t.id, { ref: e.target.value })} onBlur={(e) => upd(t.id, { ref: L.normalizeRef(e.target.value) })} onKeyDown={(e) => { if (e.key === "Enter") onSave(t); }} placeholder="Request ID, e.g. REQ-012" style={{ height: 32 }} />
                <Input value={l.name ?? ""} aria-label="Task name" onChange={(e) => upd(t.id, { name: e.target.value })} placeholder={t.legacy_name ? `Task name (${t.legacy_name})` : "Task name (optional)"} style={{ height: 32 }} />
                <span><Button size="sm" kind="primary" busy={busy === t.id} disabled={!(l.ref || "").trim()} onClick={() => onSave(t)}>Link</Button></span>
              </span>
            </td>
          </tr>
        );
      })}
    </>
  );
}
