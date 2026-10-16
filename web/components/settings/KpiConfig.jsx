"use client";
/* Setup › KPI Configuration — Odoo's kpi.config.screen: the "Actions" list a
   task can point at (kra.kpi.action_config_id; picked on KPI create). Name +
   URL + active. Odoo only lets System and the (deprecated) KPI Manager group
   touch it, so the page is wrapped in SystemOnly. */
import { useCallback, useEffect, useState } from "react";
import { Button, ErrorState, Field, IconButton, Input, Lozenge, Modal, PageHeader, Skeleton, useDialogs, useFlags } from "@/components/ui";
import * as X from "@/lib/services/sysadmin";
import SettingsNav from "./SettingsNav";
import SystemOnly from "./SystemOnly";

/* System administrators only for now: Odoo's ACL on kpi.config.screen does not
   include the KRA admin group yet, so a coordinator would only get an access error. */
export default function KpiConfig() {
  return <SystemOnly title="KPI configuration"><ConfigScreens /></SystemOnly>;
}

function ConfigScreens() {
  const flags = useFlags();
  const dlg = useDialogs();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [edit, setEdit] = useState(null); /* {id?, name, url, active} */
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(() => X.listConfigScreens().then((r) => { setRows(r || []); setErr(null); }).catch(setErr), []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    const name = edit.name.trim(), url = edit.url.trim();
    if (!name || !url) return;
    /* Odoo means the URL to be unique but doesn't enforce it; do it here. */
    if ((rows || []).some((r) => r.id !== edit.id && r.url.trim().toLowerCase() === url.toLowerCase())) { flags.err(`"${url}" is already used by another screen.`); return; }
    setBusy(true);
    try {
      if (edit.id) await X.writeConfigScreen(edit.id, { name, url, active: edit.active });
      else await X.createConfigScreen({ name, url, active: edit.active });
      flags.ok(edit.id ? "Saved." : "Added."); setEdit(null); load();
    } catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  const toggle = async (r) => { try { await X.writeConfigScreen(r.id, { active: !r.active }); flags.ok(r.active ? "Archived." : "Restored."); load(); } catch (e) { flags.err(e.message); } };
  const del = async (r) => {
    if (!(await dlg.confirm({ title: "Delete this screen?", text: `"${r.name}" will be deleted. Tasks that point at it lose that action. Archiving keeps it instead.`, confirmLabel: "Delete", danger: true }))) return;
    try { await X.deleteConfigScreen(r.id); flags.ok("Deleted."); load(); } catch (e) { flags.err(e.message); }
  };
  const shown = (rows || []).filter((r) => showArchived || r.active);

  return (
    <>
      <PageHeader crumbs={[{ label: "Settings" }, { label: "KPI configuration" }]} title="KPI configuration" meta="The Actions a task can link to (picked when a KPI is created)">
        <label className="chk"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} />Show archived</label>
        <Button kind="primary" icon="plus" onClick={() => setEdit({ name: "", url: "", active: true })}>New screen</Button>
      </PageHeader>
      <SettingsNav />
      <div className="page">
        {err && !rows && <ErrorState error={err} onRetry={load} />}
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {!rows && !err ? <div style={{ padding: 16 }}><Skeleton rows={5} /></div> : rows && (
            <table className="table">
              <thead><tr><th>Screen name</th><th>Screen URL</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td><b>{r.name}</b></td>
                    <td><span className="mini" style={{ fontFamily: "ui-monospace,monospace" }}>{r.url}</span></td>
                    <td>{r.active ? <Lozenge tone="done">Active</Lozenge> : <Lozenge tone="todo">Archived</Lozenge>}</td>
                    <td className="num"><span style={{ display: "inline-flex", gap: 2 }}>
                      <IconButton icon="pen" label="Edit" size={15} onClick={() => setEdit({ ...r })} />
                      <IconButton icon={r.active ? "eyeoff" : "eye"} label={r.active ? "Archive" : "Restore"} size={15} onClick={() => toggle(r)} />
                      <IconButton icon="trash" label="Delete" size={15} onClick={() => del(r)} />
                    </span></td>
                  </tr>
                ))}
                {!shown.length && <tr><td colSpan={4} className="empty">No screens yet. Add the first with "New screen".</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? "Edit screen" : "New screen"} width={480}
          footer={<><Button kind="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button kind="primary" busy={busy} disabled={!edit.name.trim() || !edit.url.trim()} onClick={save}>{edit.id ? "Save" : "Add"}</Button></>}>
          <Field label="Screen name"><Input value={edit.name} autoFocus onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="e.g. Deploy to staging" /></Field>
          <Field label="Screen URL"><Input value={edit.url} onChange={(e) => setEdit({ ...edit, url: e.target.value })} placeholder="e.g. /odoo/action-123" /></Field>
          <label className="chk"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} />Active</label>
        </Modal>
      )}
    </>
  );
}
