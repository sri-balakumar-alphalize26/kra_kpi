"use client";
import { useEffect, useState } from "react";
import { Button, Field, Icon, Input, useFlags } from "@/components/ui";
import { callKw } from "@/lib/api";

/* New Database handover (and the Destroy request's way in): URL, database
   name, user ID, password, plus the 8 provisioning steps. Same methods the
   Odoo form uses: kra.kpi.provision_payload / set_provision_handover /
   set_provision_step. complete_task refuses a New-DB task until all of it is
   filled. */
export default function DbHandover({ kpiId, canEdit, onChanged }) {
  const flags = useFlags();
  const [p, setP] = useState(null);
  const [f, setF] = useState({ url: "", db_name: "", username: "", password: "" });
  const [showPass, setShowPass] = useState(false);   /* masked until Show */
  const [busy, setBusy] = useState("");
  const load = () => callKw("kra.kpi", "provision_payload", [[Number(kpiId)]]).then((r) => {
    setP(r);
    setF({ url: r.url || "", db_name: r.db_name || "", username: r.username || "", password: r.password || "" });
  }).catch(() => setP(null));
  useEffect(() => { load(); }, [kpiId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p || (p.category !== "new_database" && p.category !== "db_disconnect")) return null;
  const newDb = p.category === "new_database";

  const save = async () => {
    setBusy("save");
    try {
      await callKw("kra.kpi", "set_provision_handover", [[Number(kpiId)]], { url: f.url, db_name: f.db_name, username: f.username, password: f.password });
      flags.ok("Handover saved."); load(); onChanged?.();
    } catch (e) { flags.err(e.message); } finally { setBusy(""); }
  };
  const tick = async (field, on) => {
    setBusy(field);
    try {
      await callKw("kra.kpi", "set_provision_step", [[Number(kpiId)], field, on]);
      load(); onChanged?.();
    } catch (e) { flags.err(e.message); } finally { setBusy(""); }
  };
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  return (
    <div className="sec" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h3><Icon n="link" size={14} /> {newDb ? "Database handover" : "Database to destroy"}{newDb ? <span className="mini"> · {p.progress}/{p.total} steps</span> : null}</h3>
      {p.server && <span className="mini">Server: {p.server}</span>}
      <div className="grid2">
        <Field label="Database URL" required><Input id={`dbh-url-${kpiId}`} value={f.url} onChange={set("url")} disabled={!canEdit} placeholder="https://…" /></Field>
        <Field label="Database name" required><Input id={`dbh-db-${kpiId}`} value={f.db_name} onChange={set("db_name")} disabled={!canEdit} /></Field>
        <Field label="User ID" required><Input id={`dbh-user-${kpiId}`} value={f.username} onChange={set("username")} disabled={!canEdit} autoComplete="off" /></Field>
        <Field label="Password" required><Input id={`dbh-pass-${kpiId}`} type={showPass ? "text" : "password"} value={f.password} onChange={set("password")} disabled={!canEdit} autoComplete="new-password"
          right={<button type="button" className="mini" style={{ border: 0, background: "none", cursor: "pointer" }} onClick={() => setShowPass((v) => !v)}>{showPass ? "Hide" : "Show"}</button>} /></Field>
      </div>
      {canEdit && <Button size="sm" kind="primary" busy={busy === "save"} onClick={save} style={{ alignSelf: "flex-start" }}>Save handover</Button>}
      {newDb && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {p.steps.map((s) => (
            <label key={s.field} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, cursor: canEdit ? "pointer" : "default" }}>
              <input type="checkbox" checked={s.done} disabled={!canEdit || busy === s.field} onChange={(e) => tick(s.field, e.target.checked)} />
              <span style={s.done ? { textDecoration: "line-through", color: "var(--subtle)" } : undefined}>{s.label}</span>
            </label>
          ))}
          <span className="mini">The task can be completed once the handover details and all steps are done. It then goes to an admin for approval.</span>
        </div>
      )}
    </div>
  );
}
