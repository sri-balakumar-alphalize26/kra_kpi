"use client";
/* The task panel's write-side sections, kept out of TaskPanel.jsx so the panel
   stays readable: progress updates (with files, edit, delete), user manuals,
   GitHub links, the history log with its filter, and the manager's heading
   editor. Every write reloads the panel through `onChanged` and refreshes the
   board reads (acts.refreshAll), the same way the lifecycle actions do. */
import { useEffect, useRef, useState } from "react";
import { Avatar, Button, Field, Icon, IconButton, Input, Modal, Select, Tabs, useDialogs, useFlags } from "@/components/ui";
import { href } from "@/lib/api";
import * as S from "@/lib/services/kpiActions";

const TA = { border: 0, background: "none", outline: 0, resize: "none", width: "100%", height: "100%", font: "inherit", color: "inherit" };
const CHIP = { background: "var(--hover)", color: "var(--navy)", textDecoration: "none", maxWidth: "100%" };
const ELLIPSIS = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
/* Links are typed as one box, separated by spaces, commas or new lines. */
const splitLinks = (txt) => String(txt || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
const pctOf = (l, t) => (t ? Math.min(100, Math.round((l / t) * 100)) : 0);

/* ---- small shared bits ---- */
function FilePicker({ files, setFiles, accept, disabled, label = "Attach files" }) {
  const ref = useRef(null);
  return (
    <>
      <input ref={ref} type="file" multiple accept={accept} hidden onChange={(e) => { const add = [...(e.target.files || [])]; setFiles((f) => [...f, ...add]); e.target.value = ""; }} />
      <Button size="sm" kind="ghost" icon="paperclip" disabled={disabled} onClick={() => ref.current?.click()}>{label}</Button>
      {files.map((f, i) => (
        <span key={`${f.name}${i}`} className="chip-sm" style={CHIP} title={`${f.name} · ${fmtBytes(f.size)}`}>
          <span style={ELLIPSIS}>{f.name}</span><span className="mini">{fmtBytes(f.size)}</span>
          {!disabled && <IconButton icon="x" label={`Remove ${f.name}`} size={12} onClick={() => setFiles((all) => all.filter((_, j) => j !== i))} />}
        </span>
      ))}
    </>
  );
}
function UploadBar({ pct }) {
  return <span style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}><span className="prog"><i style={{ width: `${pct}%` }} /></span><span className="mini">{pct < 100 ? `Uploading ${pct}%` : "Saving…"}</span></span>;
}
const Err = ({ children }) => (children ? <small className="err" style={{ color: "var(--danger)", fontSize: 12.5, fontWeight: 700 }}>{children}</small> : null);
/* An entry's files: the first is served by the entry's own route (id 0), the rest
   by /kpi/attachment/download — `url` already says which. */
function FileChips({ files, viewFirst }) {
  if (!files?.length) return null;
  return (
    <div className="pillset" style={{ marginTop: 6 }}>
      {files.map((f) => (
        <a key={f.id || f.url} className="chip-sm" style={CHIP} href={href(f.id === 0 && viewFirst ? viewFirst : f.url)} target="_blank" rel="noreferrer" title={f.file_name}>
          <Icon n="paperclip" size={13} /><span style={ELLIPSIS}>{f.file_name || "file"}</span>
        </a>
      ))}
    </div>
  );
}
function LinkList({ links }) {
  if (!links?.length) return null;
  return <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>{links.map((l, i) => <a key={i} href={l} target="_blank" rel="noreferrer" className="mini" style={{ ...ELLIPSIS, color: "var(--brand)" }}><Icon n="link" size={12} /> {l}</a>)}</div>;
}

/* ---- progress updates ---- */
export function ProgressComposer({ kpiId, onChanged }) {
  const flags = useFlags();
  const [summary, setSummary] = useState("");
  const [links, setLinks] = useState("");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(null);
  const [err, setErr] = useState("");
  const post = async () => {
    if (!summary.trim()) return;
    setBusy(true); setErr(""); setPct(files.length ? 0 : null);
    try {
      const res = await S.submitProgress(kpiId, { summary: summary.trim(), links: splitLinks(links), files }, (l, t) => setPct(pctOf(l, t)));
      S.assertOk(res, "Could not save the update.");
      setSummary(""); setLinks(""); setFiles([]);
      flags.ok(files.length ? `Update posted with ${files.length} file${files.length === 1 ? "" : "s"}.` : "Update posted.");
      onChanged?.();
    } catch (e) { setErr(e.message); } finally { setBusy(false); setPct(null); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="input ta" style={{ height: 72 }}><textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Add a progress update…" disabled={busy} style={TA} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) post(); }} /></span>
      <Input icon="link" value={links} onChange={(e) => setLinks(e.target.value)} disabled={busy} placeholder="Links (optional) — Drive, GitHub, … separated by spaces" />
      <div className="pillset" style={{ alignItems: "center" }}>
        <FilePicker files={files} setFiles={setFiles} disabled={busy} />
        <span style={{ marginLeft: "auto" }}><Button kind="primary" size="sm" busy={busy} disabled={!summary.trim()} onClick={post}>Post</Button></span>
      </div>
      {pct != null && <UploadBar pct={pct} />}
      <Err>{err}</Err>
    </div>
  );
}

export function ProgressItem({ p, onChanged, selected, onSelect }) {
  const flags = useFlags();
  const dlg = useDialogs();
  const links = S.parseLinks(p.related_links);
  const [edit, setEdit] = useState(null); /* { summary, links, clearFile } */
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async () => {
    setBusy(true); setErr("");
    try {
      S.assertOk(await S.updateProgress(p.id, { summary: edit.summary.trim(), links: splitLinks(edit.links), clearFile: edit.clearFile }), "Could not save.");
      flags.ok("Update saved."); setEdit(null); onChanged?.();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await dlg.confirm({ title: "Delete this update?", text: "The note and its files are removed for everyone. This cannot be undone.", confirmLabel: "Delete", danger: true }))) return;
    try { S.assertOk(await S.deleteProgress(p.id), "Could not delete."); flags.ok("Update deleted."); onChanged?.(); }
    catch (e) { flags.err(e.message); }
  };
  return (
    <div className="comment">
      {onSelect && p.can_edit && <input type="checkbox" checked={!!selected} onChange={() => onSelect(p.id)} aria-label="Select this update" style={{ width: 15, height: 15, accentColor: "var(--brand)", marginTop: 6, flex: "none" }} />}
      <Avatar name={p.employee_name} size={26} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <b>{p.employee_name}</b><small>{p.create_date}</small>
          {p.can_edit && !edit && (
            <span style={{ marginLeft: "auto", display: "inline-flex" }}>
              <IconButton icon="pen" label="Edit update" size={14} onClick={() => setEdit({ summary: p.summary || "", links: links.join(" "), clearFile: false })} />
              <IconButton icon="trash" label="Delete update" size={14} onClick={remove} />
            </span>
          )}
        </div>
        {edit ? (
          <div className="reveal" style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
            <span className="input ta" style={{ height: 72 }}><textarea value={edit.summary} autoFocus onChange={(e) => setEdit((v) => ({ ...v, summary: e.target.value }))} style={TA} /></span>
            <Input icon="link" value={edit.links} onChange={(e) => setEdit((v) => ({ ...v, links: e.target.value }))} placeholder="Links, separated by spaces" />
            {p.has_file && <label className="chk"><input type="checkbox" checked={edit.clearFile} onChange={(e) => setEdit((v) => ({ ...v, clearFile: e.target.checked }))} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} />Remove the file “{p.file_name || "file"}”</label>}
            <div className="pillset"><Button size="sm" kind="ghost" onClick={() => { setEdit(null); setErr(""); }}>Cancel</Button><Button size="sm" kind="primary" busy={busy} disabled={!edit.summary.trim()} onClick={save}>Save</Button></div>
            <Err>{err}</Err>
          </div>
        ) : (
          <>
            <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{p.summary}</p>
            <FileChips files={p.files?.length ? p.files : p.has_file ? [{ id: 0, file_name: p.file_name, url: `/kpi/progress/download?progress_id=${p.id}` }] : []} viewFirst={`/kpi/progress/view?progress_id=${p.id}`} />
            <LinkList links={links} />
          </>
        )}
      </div>
    </div>
  );
}

/* ---- files tab: attachments, manuals, GitHub, links ---- */
export function FilesTab({ kpiId, d, canManageGithub, onChanged }) {
  return (
    <div className="sec" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Manuals kpiId={kpiId} manuals={d.manuals || []} onChanged={onChanged} />
      <Github kpiId={kpiId} github={d.github || []} canDelete={canManageGithub} onChanged={onChanged} />
      <div>
        <h3>Attached to updates{d.files?.length ? ` · ${d.files.length}` : ""}</h3>
        {(d.files || []).map((f) => (
          <div key={`f${f.id}`} className="kv" style={{ padding: "6px 0" }}>
            <Icon n="doc" size={16} />
            <a className="val" href={href(`/kpi/progress/view?progress_id=${f.id}`)} target="_blank" rel="noreferrer" style={{ ...ELLIPSIS, textDecoration: "none", minWidth: 0 }}>{f.file_name || "file"}</a>
            <span className="right mini">{f.uploaded_by} {f.upload_date}<a className="icon-btn" href={href(`/kpi/progress/download?progress_id=${f.id}`)} title="Download" aria-label="Download"><Icon n="download" size={15} /></a></span>
          </div>
        ))}
        {!d.files?.length && <span className="mini">No files on progress updates yet.</span>}
      </div>
      {(d.links || []).length > 0 && (
        <div>
          <h3>Links · {d.links.length}</h3>
          {d.links.map((l, i) => (
            <div key={`l${i}`} className="kv" style={{ padding: "6px 0" }}>
              <Icon n="link" size={16} />
              <a className="val" href={l.url} target="_blank" rel="noreferrer" style={{ ...ELLIPSIS, textDecoration: "none", minWidth: 0 }} title={l.url}>{l.url}</a>
              <span className="right mini" style={{ flex: "none" }}>{l.kind ? `${l.kind} · ` : ""}{l.added_by}{l.added_date ? ` · ${l.added_date}` : ""}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Manuals({ kpiId, manuals, onChanged }) {
  const flags = useFlags();
  const dlg = useDialogs();
  const [can, setCan] = useState({}); /* manual id → can_edit, from /kpi/manual/list */
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState([]);
  const [desc, setDesc] = useState("");
  const [mlinks, setMlinks] = useState("");
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(null);
  const [err, setErr] = useState("");
  const ids = manuals.map((m) => m.id).join(",");
  useEffect(() => {
    if (!ids) { setCan({}); return; }
    let live = true;
    S.listManuals(kpiId).then((list) => { if (live) setCan(Object.fromEntries(list.map((m) => [m.id, !!m.can_edit]))); }).catch(() => {});
    return () => { live = false; };
  }, [kpiId, ids]);
  const send = async () => {
    setBusy(true); setErr(""); setPct(0);
    try {
      S.assertOk(await S.uploadManual(kpiId, { files, description: desc.trim(), links: splitLinks(mlinks) }, (l, t) => setPct(pctOf(l, t))), "Could not upload the manual.");
      flags.ok("Manual uploaded."); setFiles([]); setDesc(""); setMlinks(""); setOpen(false); onChanged?.();
    } catch (e) { setErr(e.message); } finally { setBusy(false); setPct(null); }
  };
  const remove = async (m) => {
    if (!(await dlg.confirm({ title: "Delete this manual?", text: `${m.file_name || "The manual"} and every file on it are removed.`, confirmLabel: "Delete", danger: true }))) return;
    try { S.assertOk(await S.deleteManual(m.id), "Could not delete."); flags.ok("Manual deleted."); onChanged?.(); }
    catch (e) { flags.err(e.message); }
  };
  return (
    <div>
      <h3 style={{ display: "flex", alignItems: "center" }}>User manuals{manuals.length ? ` · ${manuals.length}` : ""}{!open && <span style={{ marginLeft: "auto" }}><Button size="sm" kind="ghost" icon="upload" onClick={() => setOpen(true)}>Upload</Button></span>}</h3>
      {open && (
        <div className="reveal" style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
          <div className="pillset" style={{ alignItems: "center" }}><FilePicker files={files} setFiles={setFiles} accept=".pdf,.doc,.docx" disabled={busy} label="Choose PDF / DOC / DOCX" /></div>
          <Input value={desc} onChange={(e) => setDesc(e.target.value)} disabled={busy} placeholder="What is this manual for? (optional)" />
          <Input icon="link" value={mlinks} onChange={(e) => setMlinks(e.target.value)} disabled={busy} placeholder="Related links (optional) — separated by spaces" />
          <span className="mini">Up to 25 MB per file.</span>
          {pct != null && <UploadBar pct={pct} />}
          <div className="pillset"><Button size="sm" kind="ghost" disabled={busy} onClick={() => { setOpen(false); setFiles([]); setErr(""); }}>Cancel</Button><Button size="sm" kind="primary" busy={busy} disabled={!files.length} onClick={send}>Upload</Button></div>
          <Err>{err}</Err>
        </div>
      )}
      {manuals.map((m) => (
        <div key={`m${m.id}`} className="kv" style={{ padding: "6px 0", alignItems: "flex-start" }}>
          <Icon n="book" size={16} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="pillset">
              {(m.files?.length ? m.files : [{ id: 0, file_name: m.file_name, url: `/kpi/manual/download/${m.id}` }]).map((f) => (
                <a key={f.id || f.url} className="chip-sm" style={CHIP} href={href(f.id === 0 ? `/kpi/manual/view/${m.id}` : f.url)} target="_blank" rel="noreferrer" title={f.file_name}><Icon n="doc" size={13} /><span style={ELLIPSIS}>{f.file_name || "Manual"}</span></a>
              ))}
            </div>
            {m.reason && <p className="mini" style={{ margin: "4px 0 0" }}>{m.reason}</p>}
            <LinkList links={S.parseLinks(m.related_links)} />
            <small className="mini">{m.uploaded_by}{m.upload_date ? ` · ${m.upload_date}` : ""}</small>
          </div>
          {can[m.id] && <IconButton icon="trash" label="Delete manual" size={14} onClick={() => remove(m)} />}
        </div>
      ))}
      {!manuals.length && !open && <span className="mini">No manual uploaded yet.</span>}
    </div>
  );
}

function Github({ kpiId, github, canDelete, onChanged }) {
  const flags = useFlags();
  const dlg = useDialogs();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const add = async () => {
    setBusy(true); setErr("");
    try {
      S.assertOk(await S.addGithubLink(kpiId, url.trim(), branch.trim()), "Could not add the link.");
      flags.ok("GitHub link added."); setUrl(""); setBranch(""); setOpen(false); onChanged?.();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const remove = async (g) => {
    if (!(await dlg.confirm({ title: "Remove this GitHub link?", text: g.github_url, confirmLabel: "Remove", danger: true }))) return;
    try { S.assertOk(await S.deleteGithubLink(g.id), "Could not remove."); flags.ok("Link removed."); onChanged?.(); }
    catch (e) { flags.err(e.message); }
  };
  return (
    <div>
      <h3 style={{ display: "flex", alignItems: "center" }}>GitHub{github.length ? ` · ${github.length}` : ""}{!open && <span style={{ marginLeft: "auto" }}><Button size="sm" kind="ghost" icon="plus" onClick={() => setOpen(true)}>Add link</Button></span>}</h3>
      {open && (
        <div className="reveal" style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
          <Input value={url} autoFocus onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/org/repo" />
          <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="Branch (required)" onKeyDown={(e) => { if (e.key === "Enter" && url.trim() && branch.trim()) add(); }} />
          <div className="pillset"><Button size="sm" kind="ghost" onClick={() => { setOpen(false); setErr(""); }}>Cancel</Button><Button size="sm" kind="primary" busy={busy} disabled={!url.trim() || !branch.trim()} onClick={add}>Add</Button></div>
          <Err>{err}</Err>
        </div>
      )}
      {github.map((g) => (
        <div key={`g${g.id}`} className="kv" style={{ padding: "6px 0" }}>
          <Icon n="link" size={16} />
          <a className="val" href={g.github_url} target="_blank" rel="noreferrer" title={g.github_url} style={{ ...ELLIPSIS, textDecoration: "none", minWidth: 0 }}>{g.github_url.replace(/^https?:\/\/(www\.)?github\.com\//i, "")}</a>
          <span className="right mini" style={{ flex: "none" }}>{g.branch_name && <span className="ref">{g.branch_name}</span>}{g.employee_name}{canDelete && <IconButton icon="trash" label="Remove link" size={14} onClick={() => remove(g)} />}</span>
        </div>
      ))}
      {!github.length && !open && <span className="mini">No GitHub link yet.</span>}
    </div>
  );
}

/* ---- history ---- */
const KINDS = [{ key: "all", label: "All" }, { key: "pause", label: "Pause / resume" }, { key: "heading", label: "Heading" }];
const SHOWN = 20;
function eventIcon(ev) {
  if (/pause/.test(ev)) return "pause";
  if (/start|resume/.test(ev)) return "play";
  if (/reassign|switch/.test(ev)) return "swap";
  if (ev === "meta_updated") return "pen";
  if (ev === "priority_changed") return "flag";
  if (/approv|complete/.test(ev)) return "check";
  return "clock";
}
/* `detail` is the log's payload JSON, cut at 400 chars — parse what parses. */
function describe(a) {
  const raw = a.detail || "";
  let p = null;
  try { p = JSON.parse(raw); } catch (_) { return raw && raw[0] !== "{" ? raw : ""; }
  if (!p || typeof p !== "object") return "";
  if (a.event === "meta_updated") {
    const out = [];
    if (p.name_from !== p.name_to) out.push(`“${p.name_from}” → “${p.name_to}”`);
    if (p.kra_from !== p.kra_to) out.push(`project ${p.kra_from || "—"} → ${p.kra_to || "—"}`);
    return out.join(" · ");
  }
  if (p.from != null && p.to != null && typeof p.from !== "object") return `${p.from} → ${p.to}${p.reason ? ` — ${p.reason}` : ""}`;
  return p.reason || p.note || p.message || p.error || "";
}

export function HistoryTab({ kpiId, d }) {
  const [kind, setKind] = useState("all");
  const [log, setLog] = useState(null); /* {activity_log, activity_total, activity_limit} for a filtered kind */
  const [err, setErr] = useState("");
  const [all, setAll] = useState(false);
  /* previous_state / was_paused / pause_reason live only on this route. */
  const [reh, setReh] = useState(null);
  const reCount = (d.reassignments || []).length;
  useEffect(() => {
    if (!reCount) { setReh(null); return; }
    let live = true;
    S.fetchReassignmentHistory(kpiId).then((h) => { if (live) setReh(Object.fromEntries(h.map((x) => [x.id, x]))); }).catch(() => {});
    return () => { live = false; };
  }, [kpiId, reCount]);
  useEffect(() => {
    setAll(false);
    if (kind === "all") { setLog(null); return; }
    let live = true;
    setLog(undefined); setErr("");
    S.fetchActivity(kpiId, kind).then((r) => { if (!live) return; if (r.status) setLog(r); else { setErr(r.message); setLog(null); } }).catch((e) => { if (live) { setErr(e.message); setLog(null); } });
    return () => { live = false; };
  }, [kpiId, kind]);
  const src = kind === "all" ? d : log || { activity_log: [], activity_total: 0, activity_limit: 0 };
  const rows = src.activity_log || [];
  const shown = all ? rows : rows.slice(0, SHOWN);
  const est = d.estimate_history || [];
  return (
    <div className="sec" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Tabs items={KINDS} value={kind} onChange={setKind} />
      {log === undefined && <span className="mini" style={{ padding: "8px 0" }}>Loading…</span>}
      <Err>{err}</Err>
      {shown.map((a) => {
        const txt = describe(a);
        return (
          <div key={a.id} className="notif" style={{ padding: "8px 0" }}>
            <span className="icbox" style={{ background: a.success === false ? "var(--over-bg)" : "var(--hover)", color: a.success === false ? "var(--over)" : "var(--subtle)", width: 28, height: 28 }}><Icon n={a.success === false ? "warn" : eventIcon(a.event)} size={14} /></span>
            <div style={{ minWidth: 0 }}><p style={{ overflowWrap: "anywhere" }}>{a.label}{txt ? <span style={{ color: "var(--subtle)" }}> — {txt}</span> : null}</p><small>{a.at}{a.actor ? ` · ${a.actor}` : ""}</small></div>
          </div>
        );
      })}
      {log !== undefined && !rows.length && <span className="mini" style={{ padding: "8px 0" }}>{kind === "all" ? "Nothing logged yet." : "Nothing of this kind logged yet."}</span>}
      {rows.length > SHOWN && <span><Button size="sm" kind="ghost" onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${rows.length}`}</Button></span>}
      {src.activity_total > rows.length && <span className="mini">Showing the latest {rows.length} of {src.activity_total} entries.</span>}

      {kind === "all" && (d.reassignments || []).length > 0 && (
        <>
          <h3 style={{ marginTop: 12 }}>Reassignments</h3>
          {d.reassignments.map((r) => {
            const x = reh?.[r.id] || {};
            return (
              <div key={`r${r.id}`} className="notif" style={{ padding: "8px 0" }}>
                <span className="icbox" style={{ background: "var(--lz-review-bg)", color: "var(--lz-review)", width: 28, height: 28 }}><Icon n="swap" size={14} /></span>
                <div>
                  <p>{r.previous_assignee || "—"} → {r.new_assignee}{x.previous_state ? <> <span className="ref" title="State before the reassignment">{x.previous_state}</span></> : null}{r.time_spent ? <span className="mini"> · {r.time_spent} spent before</span> : null}</p>
                  <small>{r.reassignment_date} · {r.reassigned_by}{r.reason ? ` · “${r.reason}”` : ""}</small>
                  {x.was_paused && <small style={{ display: "block", color: "var(--danger)" }}>Was paused{x.pause_reason ? `: ${x.pause_reason}` : ""}</small>}
                </div>
              </div>
            );
          })}
        </>
      )}
      {kind === "all" && est.length > 0 && (
        <>
          <h3 style={{ marginTop: 12 }}>Estimate</h3>
          {est.map((e) => (
            <div key={`e${e.seq}`} className="notif" style={{ padding: "8px 0" }}>
              <span className="icbox" style={{ background: "var(--lz-paused-bg)", color: "var(--lz-paused)", width: 28, height: 28 }}><Icon n="clock" size={14} /></span>
              <div>
                <p>{e.kind === "original" ? <>Original estimate <b>{e.value}</b></> : <>Extended <b>{e.value}</b>{e.running_total ? <> → {e.running_total}</> : null}{e.reason ? <span style={{ color: "var(--subtle)" }}> — {e.reason}</span> : null}</>}</p>
                {e.kind !== "original" && <small>{e.at}{e.actor ? ` · ${e.actor}` : ""}</small>}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/* ---- edit heading (manager) ---- */
const PREFIX = /^\[(Update|Bug)\]\s*/;
export function EditHeadingDialog({ task, onClose, onSaved }) {
  const flags = useFlags();
  const dlg = useDialogs();
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState("requirement");
  const [kra, setKra] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    S.fetchActionDetails(task.id).then((r) => { setInfo(r); setName((r.name || "").replace(PREFIX, "")); setType(r.type || "requirement"); setKra(r.kra_id ? String(r.kra_id) : ""); }).catch((e) => setErr(e.message));
  }, [task.id]);
  const kras = info?.available_kras || [];
  const cur = kras.find((k) => k.id === info?.kra_id);
  const pick = kras.find((k) => String(k.id) === kra);
  const crossing = cur && pick && cur.root_id !== pick.root_id;
  const changes = info ? {
    name: name.trim() && name.trim() !== (info.name || "").replace(PREFIX, "") ? name.trim() : "",
    type: type !== info.type ? type : false,
    kraId: kra && +kra !== info.kra_id ? +kra : false,
  } : {};
  const dirty = !!(changes.name || changes.type || changes.kraId);
  const save = async () => {
    setBusy(true); setErr("");
    try {
      let res = await S.updateTaskMeta(task.id, changes);
      if (res?.needs_confirm) {
        const yes = await dlg.confirm({ title: "Move to another client?", confirmLabel: "Yes, move it", danger: true,
          text: `This moves ${task.external_ref || "the task"} from “${res.from_client}” to “${res.to_client}”. Its work and history go with it.` });
        if (!yes) { setBusy(false); return; }
        res = await S.updateTaskMeta(task.id, { ...changes, confirmClientMove: true });
      }
      S.assertOk(res, "Could not save the heading.");
      flags.ok("Task updated."); onSaved?.(); onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={<span>Edit heading <span className="ref" style={{ fontSize: 12, verticalAlign: "middle" }}>{task.external_ref || `#${task.id}`}</span></span>} width={560}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} disabled={!info || !dirty || !name.trim()} onClick={save}>Save</Button></>}>
      {!info && !err && <span className="mini">Loading…</span>}
      {info && (
        <>
          <Field label="Name"><Input value={name} autoFocus onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Type" hint="Changing the type also changes the REQ / UPD / BUG reference."><Tabs items={S.TASK_TYPES.map((t) => ({ key: t.code, label: t.label }))} value={type} onChange={setType} /></Field>
          <Field label="Project">
            <span className="input"><Select value={kra} onChange={(e) => setKra(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}>
              {!info.kra_id && <option value="">No project</option>}
              {kras.map((k) => <option key={k.id} value={k.id}>{k.display}</option>)}
            </Select></span>
          </Field>
          {crossing && <div className="callout reveal" style={{ background: "var(--lz-paused-bg)", borderColor: "var(--pri-important)", color: "var(--lz-paused)" }}><Icon n="warn" size={16} /><span>This moves the task from <b>{cur.root_name}</b> to <b>{pick.root_name}</b> — another client. You'll be asked to confirm.</span></div>}
        </>
      )}
      <Err>{err}</Err>
    </Modal>
  );
}

/* Progress history with select-and-delete (Odoo deleteSelectedProgress): only
   rows the server marked can_edit can be ticked; /kpi/progress/delete_bulk
   deletes what it may and reports the rest. */
export function ProgressList({ progress, onChanged }) {
  const flags = useFlags();
  const dlg = useDialogs();
  const [sel, setSel] = useState({});
  const [busy, setBusy] = useState(false);
  const deletable = progress.filter((p) => p.can_edit);
  const ids = deletable.filter((p) => sel[p.id]).map((p) => p.id);
  const allOn = deletable.length > 0 && deletable.every((p) => sel[p.id]);
  const toggle = (id) => setSel((s) => ({ ...s, [id]: !s[id] }));
  const remove = async () => {
    if (!ids.length) return;
    if (!(await dlg.confirm({ title: ids.length === 1 ? "Delete this update?" : `Delete ${ids.length} updates?`, text: "This removes the note, its links and any attached file. It cannot be undone.", confirmLabel: "Delete", danger: true }))) return;
    setBusy(true);
    try {
      const res = S.assertOk(await S.deleteProgressBulk(ids), "Couldn't delete those.");
      const refused = res.refused || 0;
      if (refused) flags.warn(`Deleted ${res.deleted}; ${refused} belonged to someone else.`); else flags.ok(`Deleted ${res.deleted}.`);
      setSel({}); onChanged?.();
    } catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  return (
    <>
      {deletable.length > 1 && (
        <div className="pillset" style={{ alignItems: "center" }}>
          <label className="chk" style={{ margin: 0 }}><input type="checkbox" checked={allOn} onChange={() => setSel(allOn ? {} : Object.fromEntries(deletable.map((p) => [p.id, true])))} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} />Select all</label>
          {ids.length > 0 && <><Button size="sm" kind="danger" icon="trash" busy={busy} onClick={remove}>Delete {ids.length}</Button><Button size="sm" kind="ghost" onClick={() => setSel({})}>Clear</Button></>}
        </div>
      )}
      {progress.map((p) => <ProgressItem key={p.id} p={p} onChanged={onChanged} selected={!!sel[p.id]} onSelect={deletable.length > 1 ? toggle : null} />)}
    </>
  );
}
