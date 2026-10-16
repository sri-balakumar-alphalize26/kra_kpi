"use client";
/* Settings › Data Cleanup (+ Data Cleanup Password) — Odoo's kpi.data.cleanup
   behind the cleanup password, System administrators only.

   Flow, same as the Odoo screen plus a preview step:
     1. Unlock with the cleanup password (Odoo's kpi.cleanup.auth check).
     2. Choose what to clean → Preview: a draft cleanup is created and
        /kpi_cleanup/preview counts what WOULD be deleted. Changing the choice
        throws the draft away.
     3. Delete: type DELETE and the password again; the password is re-checked
        with Odoo right before /kpi_cleanup/execute (Odoo itself only checks it
        when the menu opens). Odoo makes a full backup first unless told not to.

   The /kpi_cleanup/* routes are only proxied for System admins (proxy check). */
import { useCallback, useEffect, useState } from "react";
import { Button, ErrorState, Field, Input, Lozenge, Modal, PageHeader, Skeleton, Tabs, useDialogs, useFlags } from "@/components/ui";
import * as X from "@/lib/services/sysadmin";
import SettingsNav from "./SettingsNav";
import SystemOnly from "./SystemOnly";

export default function DataCleanup() {
  return <SystemOnly title="Data cleanup"><Cleanup /></SystemOnly>;
}

function Cleanup() {
  const [unlocked, setUnlocked] = useState(false);
  return (
    <>
      <PageHeader crumbs={[{ label: "Settings" }, { label: "Data cleanup" }]} title="Data cleanup" meta="Permanently delete KRA / KPI data — System administrators only" />
      <SettingsNav />
      <div className="page">{unlocked ? <Workspace /> : <Unlock onOk={() => setUnlocked(true)} />}</div>
    </>
  );
}

function PasswordInput({ value, onChange, autoFocus, placeholder = "Cleanup password" }) {
  return <span className="input"><input type="password" value={value} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }} /></span>;
}

function Unlock({ onOk }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async (e) => {
    e?.preventDefault(); if (!pw) return;
    setBusy(true); setErr("");
    try { await X.verifyCleanupPassword(pw); onOk(); } catch (ex) { setErr(/incorrect/i.test(ex.message) ? "Incorrect password." : ex.message); } finally { setBusy(false); }
  };
  return (
    <form className="cardbox" style={{ maxWidth: 440 }} onSubmit={go}>
      <b style={{ color: "var(--navy)", fontSize: 16 }}>🔒 Enter the cleanup password</b>
      <p className="note" style={{ margin: 0 }}>Data cleanup permanently deletes records. The cleanup password (set under Change password once unlocked) is needed to continue.</p>
      <PasswordInput value={pw} onChange={setPw} autoFocus />
      {err && <small className="err" style={{ color: "var(--danger)", fontWeight: 700 }}>{err}</small>}
      <Button kind="primary" busy={busy} disabled={!pw} type="submit" style={{ alignSelf: "flex-start" }}>Unlock</Button>
    </form>
  );
}

const TYPES = [{ key: "selective", label: "Selected types" }, { key: "old_data", label: "Old data" }, { key: "clean_all", label: "Everything" }];
const blankOpts = () => ({ cleanup_type: "selective", ...Object.fromEntries(X.CLEAN.map(([k]) => [k, false])), days_old: 90, only_completed: true, create_backup_before: true, force_cleanup_without_backup: false });

function Workspace() {
  const flags = useFlags();
  const dlg = useDialogs();
  const [stats, setStats] = useState(null);
  const [backup, setBackup] = useState(null);
  const [hist, setHist] = useState(null);
  const [err, setErr] = useState(null);
  const [opts, setOpts] = useState(blankOpts);
  const [draft, setDraft] = useState(null); /* {id, preview, backup_warning} */
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const [pwOpen, setPwOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, b, h] = await Promise.all([X.cleanupStats(), X.cleanupBackupStatus(), X.listCleanups()]);
      X.ok(s); X.ok(b); setStats(s.statistics || {}); setBackup(b); setHist(h || []); setErr(null);
    } catch (e) { setErr(e); }
  }, []);
  useEffect(() => { load(); }, [load]);

  /* Any change to the choice invalidates a preview: drop the draft. */
  const discard = useCallback(async () => { if (draft?.id) { X.deleteCleanupDraft(draft.id).catch(() => {}); } setDraft(null); }, [draft]);
  const set = (patch) => { if (draft) discard(); setOpts((o) => ({ ...o, ...patch })); };
  const setType = (t) => {
    const flagsFor = t === "clean_all" ? Object.fromEntries(X.CLEAN.map(([k]) => [k, true])) : t === "old_data" ? Object.fromEntries(X.CLEAN.map(([k]) => [k, X.OLD_DATA_KEYS.includes(k)])) : Object.fromEntries(X.CLEAN.map(([k]) => [k, false]));
    set({ cleanup_type: t, ...flagsFor });
  };
  const anyPicked = X.CLEAN.some(([k]) => opts[k]);
  const noRecentBackup = backup && !backup.has_recent_backup;

  const preview = async () => {
    setBusy("preview"); setResult(null);
    try {
      const id = await X.createCleanup({ name: `Cleanup ${new Date().toLocaleString()}`, ...opts, days_old: Math.max(1, +opts.days_old || 0) });
      const p = X.ok(await X.previewCleanup(Array.isArray(id) ? id[0] : id), "Could not preview.");
      setDraft({ id: Array.isArray(id) ? id[0] : id, preview: p.preview || {}, backup_warning: p.backup_warning });
    } catch (e) { flags.err(e.message); } finally { setBusy(null); }
  };
  const total = draft ? Object.values(draft.preview).reduce((a, b) => a + (+b || 0), 0) : 0;

  const execute = async () => {
    const v = await dlg.form({
      title: `Permanently delete ${total} record${total === 1 ? "" : "s"}?`, confirmLabel: "Delete permanently",
      text: `${opts.create_backup_before ? "A full backup is made first, then " : "NO backup is made first. "}the records counted in the preview are deleted for good. This can't be undone from here.`,
      fields: [{ key: "word", label: "Type DELETE to confirm", value: "", placeholder: "DELETE" }, { key: "pw", label: "Cleanup password", value: "", placeholder: "Cleanup password", type: "password" }],
    });
    if (!v) return;
    if (v.word.trim() !== "DELETE") { flags.warn("Nothing deleted — you didn't type DELETE."); return; }
    setBusy("execute");
    try {
      await X.verifyCleanupPassword(v.pw); /* checked again, right before deleting */
      const r = X.ok(await X.executeCleanup(draft.id), "Cleanup failed.");
      setResult(r); setDraft(null); setOpts(blankOpts()); flags.ok("Cleanup finished."); load();
    } catch (e) { flags.err(/incorrect/i.test(e.message) ? "Incorrect password — nothing was deleted." : e.message); load(); } finally { setBusy(null); }
  };

  if (err && !stats) return <ErrorState error={err} onRetry={load} />;
  if (!stats) return <div className="cardbox"><Skeleton rows={6} /></div>;
  return (
    <>
      <div className="callout" style={backup?.has_recent_backup ? { background: "var(--lz-done-bg)", borderColor: "var(--pri-regular)", color: "var(--lz-done)" } : { background: "var(--over-bg)", borderColor: "var(--danger)", color: "var(--over)" }}>
        <span style={{ flex: 1 }}>{backup?.has_backup ? <>Last backup <b>{backup.backup_name || ""}</b> · {X.local(backup.last_backup_date, { date: true })} ({backup.days_since_backup} day{backup.days_since_backup === 1 ? "" : "s"} ago){backup.has_recent_backup ? "" : " — older than 7 days."}</> : "No backup has been made yet."}</span>
        <a className="btn" href="/settings/backup" style={{ height: 30, fontSize: 12.5 }}>Backups</a>
        <Button size="sm" kind="ghost" onClick={() => setPwOpen(true)}>Change password</Button>
      </div>

      <div className="stats s5">
        <div className="stat"><small>KRAs</small><b>{stats.total_kras ?? 0}</b></div>
        <div className="stat"><small>KPIs / tasks</small><b>{stats.total_kpis ?? 0}</b><span>{stats.kpi_by_state ? `${stats.kpi_by_state.completed || 0} completed` : ""}</span></div>
        <div className="stat"><small>Progress updates</small><b>{stats.total_progress ?? 0}</b></div>
        <div className="stat"><small>Manuals · links</small><b>{(stats.total_manuals ?? 0) + (stats.total_github ?? 0)}</b><span>{stats.total_manuals ?? 0} manuals · {stats.total_github ?? 0} links</span></div>
        <div className="stat"><small>Reassignments · reports</small><b>{(stats.total_reassignments ?? 0) + (stats.total_reports ?? 0)}</b></div>
      </div>

      <div className="cardbox">
        <h2>New cleanup</h2>
        <Tabs items={TYPES} value={opts.cleanup_type} onChange={setType} />
        <p className="mini" style={{ margin: 0 }}>
          {opts.cleanup_type === "selective" ? "Deletes ALL records of each ticked type (no date limit)." : opts.cleanup_type === "old_data" ? "Deletes tasks, progress and reassignments older than the age below." : "Deletes every record of every type."}
        </p>
        {opts.cleanup_type === "old_data" ? (
          <div className="fit-row">
            <Field label="Older than (days)" className="grow"><Input type="number" min="1" value={opts.days_old} onChange={(e) => set({ days_old: e.target.value })} /></Field>
            <label className="chk" style={{ alignSelf: "flex-end", marginBottom: 8 }}><input type="checkbox" checked={opts.only_completed} onChange={(e) => set({ only_completed: e.target.checked })} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} />Only completed tasks</label>
          </div>
        ) : (
          <div className="grid2">{X.CLEAN.map(([k, l]) => <label key={k} className="chk"><input type="checkbox" checked={!!opts[k]} disabled={opts.cleanup_type === "clean_all"} onChange={(e) => set({ [k]: e.target.checked })} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} />{l}</label>)}</div>
        )}
        <div className="ewd-box" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <b style={{ color: "var(--navy)", fontSize: 13.5 }}>Backup safety</b>
          <label className="chk"><input type="checkbox" checked={opts.create_backup_before} onChange={(e) => set({ create_backup_before: e.target.checked })} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} />Make a full backup first (recommended)</label>
          {noRecentBackup && <label className="chk" style={{ color: "var(--danger)" }}><input type="checkbox" checked={opts.force_cleanup_without_backup} onChange={(e) => set({ force_cleanup_without_backup: e.target.checked })} style={{ width: 15, height: 15, accentColor: "var(--danger)" }} />Run even though there's no backup from the last 7 days</label>}
        </div>
        {!draft ? (
          <Button kind="primary" busy={busy === "preview"} disabled={!anyPicked} onClick={preview} style={{ alignSelf: "flex-start" }}>Preview what would be deleted</Button>
        ) : (
          <div className="ewd-box warn reveal" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <b style={{ color: "var(--over)" }}>This would delete {total} record{total === 1 ? "" : "s"}:</b>
            <div className="ewd-away">{X.CLEAN.filter(([, , p]) => draft.preview[p]).map(([, l, p]) => <span key={p} className="ewd-tag"><b>{draft.preview[p]}</b>{l}</span>)}{!total && <span className="mini">Nothing matches — there's nothing to delete.</span>}</div>
            {draft.backup_warning && <span className="mini" style={{ color: "var(--danger)", fontWeight: 700 }}>{draft.backup_warning}</span>}
            <div style={{ display: "flex", gap: 8 }}>
              <Button kind="danger" icon="trash" busy={busy === "execute"} disabled={!total || (noRecentBackup && !opts.create_backup_before && !opts.force_cleanup_without_backup)} onClick={execute}>Delete permanently…</Button>
              <Button kind="ghost" disabled={busy === "execute"} onClick={discard}>Cancel</Button>
            </div>
            {busy === "execute" && <span className="mini">Working… {opts.create_backup_before ? "making the backup, then " : ""}deleting. Keep this page open.</span>}
          </div>
        )}
        {result && (
          <div className="callout reveal" style={{ background: "var(--lz-done-bg)", borderColor: "var(--pri-regular)", color: "var(--lz-done)" }}>
            <span style={{ whiteSpace: "pre-line" }}><b>Done.</b> {result.message || ""}{result.deleted_counts ? ` Deleted: ${X.CLEAN.map(([, l, p]) => `${result.deleted_counts[p] || 0} ${l.toLowerCase()}`).join(", ")}.` : ""}</span>
          </div>
        )}
      </div>

      <div className="cardbox table-scroll" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr><th>Cleanup</th><th>Date</th><th>Type</th><th>By</th><th className="num">Tasks</th><th className="num">Progress</th><th className="num">Other</th><th>Backup</th><th>Status</th></tr></thead>
          <tbody>
            {(hist || []).map((c) => (
              <tr key={c.id}>
                <td><b>{c.name}</b></td><td>{X.local(c.cleanup_date, { date: true })}</td>
                <td>{TYPES.find((t) => t.key === c.cleanup_type)?.label || c.cleanup_type}</td><td>{X.m2o(c.executed_by) || "—"}</td>
                <td className="num">{c.kpis_deleted || 0}</td><td className="num">{c.progress_deleted || 0}</td>
                <td className="num">{(c.kras_deleted || 0) + (c.manuals_deleted || 0) + (c.github_deleted || 0) + (c.reassignments_deleted || 0) + (c.reports_deleted || 0)}</td>
                <td>{X.m2o(c.backup_created_id) || "—"}</td>
                <td><Lozenge tone={c.state === "completed" ? "done" : c.state === "failed" ? "danger" : "progress"}>{c.state}</Lozenge></td>
              </tr>
            ))}
            {!(hist || []).length && <tr><td colSpan={9} className="empty">No cleanups have been run.</td></tr>}
          </tbody>
        </table>
      </div>
      {pwOpen && <ChangePassword onClose={() => setPwOpen(false)} />}
    </>
  );
}

/* Settings › Data Cleanup Password: change it (the current one is required). */
function ChangePassword({ onClose }) {
  const flags = useFlags();
  const [info, setInfo] = useState(null);
  const [cur, setCur] = useState(""); const [next, setNext] = useState(""); const [conf, setConf] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { X.cleanupPasswordInfo().then(setInfo).catch(() => setInfo({})); }, []);
  const mismatch = conf && next !== conf;
  const save = async () => {
    setBusy(true);
    try { const r = await X.changeCleanupPassword(cur, next, conf); flags.ok(X.notice(r) || "Cleanup password changed."); onClose(); }
    catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Change the cleanup password" width={460}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} disabled={!cur || next.length < 6 || next !== conf} onClick={save}>Change password</Button></>}>
      <p className="mini" style={{ margin: 0 }}>{info?.last_changed_date ? `Last changed ${X.local(info.last_changed_date, { date: true })}${info.last_changed_by ? ` by ${X.m2o(info.last_changed_by)}` : ""}.` : "Not changed yet — if it was never set, Odoo's default is still in place, so change it now."}</p>
      <Field label="Current password"><PasswordInput value={cur} onChange={setCur} autoFocus placeholder="Current password" /></Field>
      <Field label="New password (at least 6 characters)"><PasswordInput value={next} onChange={setNext} placeholder="New password" /></Field>
      <Field label="Confirm new password" error={mismatch ? "Doesn't match." : null}><PasswordInput value={conf} onChange={setConf} placeholder="Confirm new password" /></Field>
    </Modal>
  );
}
