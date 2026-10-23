"use client";
/* Settings › Backup & Restore — Odoo's kpi.backup (System only on the web).
   Create runs Odoo's action_create_backup (a ZIP of KRA/KPI data, built
   synchronously — can take minutes). Download streams /web/content. Restore is
   ADDITIVE in Odoo: it creates the records again on top of what is there (and
   rewrites salary configs), so it sits behind a typed confirmation. The file
   itself is never read into the list. */
import { useCallback, useEffect, useState } from "react";
import { Button, ErrorState, Field, Input, Lozenge, Modal, PageHeader, Skeleton, Tabs, useDialogs, useFlags } from "@/components/ui";
import * as X from "@/lib/services/sysadmin";
import SettingsNav from "./SettingsNav";
import SystemOnly from "./SystemOnly";

const STATE = { draft: ["todo", "Draft"], in_progress: ["progress", "Running"], completed: ["done", "Completed"], failed: ["danger", "Failed"] };

export default function Backups() {
  return <SystemOnly title="Backup & restore"><BackupList /></SystemOnly>;
}

function BackupList() {
  const flags = useFlags();
  const dlg = useDialogs();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [create, setCreate] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => X.listBackups().then((r) => { setRows(r || []); setErr(null); }).catch(setErr), []);
  useEffect(() => { load(); }, [load]);

  const start = () => setCreate({ name: `Backup ${new Date().toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}`, backup_type: "full", ...Object.fromEntries(X.INCLUDES.map(([k]) => [k, true])), notes: "" });

  const run = async () => {
    setBusy("create");
    try {
      const id = await X.createBackupRecord({ ...create, name: create.name.trim() });
      let res = await X.runBackup(id);
      /* Incremental with no full backup yet: Odoo switches it to full and stops — run again. */
      const [b] = (await X.readBackup(id)) || [];
      if (b && b.state === "draft") res = await X.runBackup(id);
      flags.ok(X.notice(res) || "Backup created.");
      setCreate(null); load();
    } catch (e) { flags.err(e.message); load(); } finally { setBusy(null); }
  };

  const restore = async (b) => {
    const v = await dlg.form({ title: `Restore "${b.name}"?`, confirmLabel: "Restore", fields: [{ key: "word", label: "Type RESTORE to confirm", value: "", placeholder: "RESTORE" }],
      text: "Restore ADDS the backed-up KRAs, tasks, progress, manuals, links and reassignments again on top of the current data — it does not replace them, so anything still here will be duplicated. Salary settings in the backup overwrite the current ones. This can't be undone." });
    if (!v) return;
    if (v.word.trim() !== "RESTORE") { flags.warn("Not restored — you didn't type RESTORE."); return; }
    setBusy(`restore-${b.id}`);
    try { const res = await X.restoreBackup(b.id); flags.ok(X.notice(res) || "Restored."); load(); }
    catch (e) { flags.err(e.message); } finally { setBusy(null); }
  };
  const del = async (b) => {
    if (!(await dlg.confirm({ title: "Delete this backup?", text: `"${b.name}" and its file are deleted for good.`, confirmLabel: "Delete", danger: true }))) return;
    try { await X.deleteBackup(b.id); flags.ok("Deleted."); load(); } catch (e) { flags.err(e.message); }
  };

  return (
    <>
      <PageHeader crumbs={[{ label: "Settings" }, { label: "Backup & restore" }]} title="Backup & restore" meta="ZIP backups of the KRA / KPI data, made by Odoo">
        <Button kind="primary" icon="plus" onClick={start}>New backup</Button>
      </PageHeader>
      <SettingsNav />
      <div className="page">
        {err && !rows && <ErrorState error={err} onRetry={load} />}
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {!rows && !err ? <div style={{ padding: 16 }}><Skeleton rows={5} /></div> : rows && (
            <table className="table">
              <thead><tr><th>Name</th><th>Date</th><th>Type</th><th className="num">Size</th><th className="num">KRAs</th><th className="num">KPIs</th><th className="num">Files</th><th className="num">Links</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {rows.map((b) => {
                  const [tone, label] = STATE[b.state] || ["todo", b.state];
                  return (
                    <tr key={b.id}>
                      <td style={{ whiteSpace: "normal" }}><b>{b.name}</b>{b.error_log && <div className="mini" style={{ color: "var(--danger)" }}>{String(b.error_log).slice(0, 140)}</div>}</td>
                      <td>{X.local(b.backup_date, { date: true })}</td>
                      <td><span style={{ textTransform: "capitalize" }}>{b.backup_type}</span>
                        {b.backup_type === "incremental" && (b.reference_date || b.last_full_backup_id) && <div className="mini" title="Records modified after the reference date are included">
                          {b.reference_date && <>Since {X.local(b.reference_date, { date: true })}</>}{b.last_full_backup_id && <> · full: {X.m2o(b.last_full_backup_id)}{b.last_full_backup_date ? ` (${X.local(b.last_full_backup_date, { date: true })})` : ""}</>}
                        </div>}</td>
                      <td className="num">{b.backup_size ? `${Number(b.backup_size).toFixed(2)} MB` : "—"}</td>
                      <td className="num">{b.kra_count || 0}</td><td className="num">{b.kpi_count || 0}</td><td className="num">{b.attachment_count || 0}</td><td className="num">{b.links_count || 0}</td>
                      <td><Lozenge tone={tone}>{label}</Lozenge>{b.is_restored && <div className="mini">Restored {X.local(b.restored_date, { date: true })}{b.restored_by ? ` by ${X.m2o(b.restored_by)}` : ""}</div>}</td>
                      <td><span style={{ display: "inline-flex", gap: 6 }}>
                        {b.state === "completed" && b.backup_filename && <a className="btn" style={{ height: 28, fontSize: 12.5 }} href={X.backupDownloadUrl(b)}>Download</a>}
                        {b.state === "completed" && <Button size="sm" kind="ghost" busy={busy === `restore-${b.id}`} onClick={() => restore(b)}>Restore</Button>}
                        <Button size="sm" kind="ghost" onClick={() => del(b)}>Delete</Button>
                      </span></td>
                    </tr>
                  );
                })}
                {!rows.length && <tr><td colSpan={10} className="empty">No backups yet.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {create && (
        <Modal open onClose={() => busy ? null : setCreate(null)} title="New backup" width={560}
          footer={<><Button kind="ghost" disabled={!!busy} onClick={() => setCreate(null)}>Cancel</Button><Button kind="primary" busy={busy === "create"} disabled={!create.name.trim() || !X.INCLUDES.some(([k]) => create[k])} onClick={run}>Create backup</Button></>}>
          <Field label="Name" required><Input value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value })} /></Field>
          <Field label="Type"><Tabs items={[{ key: "full", label: "Full" }, { key: "incremental", label: "Incremental" }, { key: "selective", label: "Selective" }]} value={create.backup_type} onChange={(v) => setCreate({ ...create, backup_type: v })} /></Field>
          <p className="mini" style={{ margin: 0 }}>{create.backup_type === "incremental" ? "Only what changed since the last full backup (a full one is made first if there is none)." : "Everything ticked below."}</p>
          <div className="grid2">{X.INCLUDES.map(([k, l]) => <label key={k} className="chk"><input type="checkbox" checked={!!create[k]} onChange={(e) => setCreate({ ...create, [k]: e.target.checked })} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} />{l}</label>)}</div>
          <Field label="Notes (optional)"><Input value={create.notes} onChange={(e) => setCreate({ ...create, notes: e.target.value })} /></Field>
          {busy === "create" && <p className="mini" style={{ margin: 0 }}>Building the backup… this can take a few minutes for a large database. Keep this page open.</p>}
        </Modal>
      )}
    </>
  );
}
