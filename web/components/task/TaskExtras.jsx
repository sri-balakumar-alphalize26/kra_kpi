"use client";
/* The task panel's write-side sections, kept out of TaskPanel.jsx so the panel
   stays readable: progress updates (with files, edit, delete), user manuals,
   GitHub links, the history log with its filter, and the manager's heading
   editor. Every write reloads the panel through `onChanged` and refreshes the
   board reads (acts.refreshAll), the same way the lifecycle actions do. */
import { useEffect, useRef, useState } from "react";
import { Avatar, Button, Field, Icon, IconButton, Input, Lozenge, Modal, Select, Tabs, useDialogs, useFlags } from "@/components/ui";
import CopyLink from "@/components/ui/CopyLink";
import { href, UPLOAD_CANCELLED } from "@/lib/api";
import { resolveGithubLink } from "@/lib/githubLink";
import { fmtBytes, progressLine, rateTracker } from "@/lib/uploadRate";
import * as S from "@/lib/services/kpiActions";
import * as P from "@/lib/services/approvals";

const TA = { border: 0, background: "none", outline: 0, resize: "none", width: "100%", height: "100%", font: "inherit", color: "inherit" };
const CHIP = { background: "var(--hover)", color: "var(--navy)", textDecoration: "none", maxWidth: "100%" };
const ELLIPSIS = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
/* Links are typed as one box, separated by spaces, commas or new lines. */
const splitLinks = (txt) => String(txt || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
/* The server's times arrive already in the viewer's timezone as
   "YYYY-MM-DD HH:MM:SS"; shown as "17 Oct 2026, 11:53 AM". Anything else is
   passed through unchanged rather than guessed at. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtStamp = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s || "");
  if (!m) return s || "";
  const h = +m[4];
  return `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}, ${h % 12 || 12}:${m[5]} ${h < 12 ? "AM" : "PM"}`;
};
/* "Today, 11:53 AM" / "Yesterday, 6:20 PM" / "17 Oct 2026, 11:53 AM". The stamp is
   already in the viewer's timezone, so its own date is compared with today's. */
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function dayWord(s) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s || "");
  if (!m) return "";
  const now = new Date();
  if (m[1] === localDay(now)) return "Today";
  if (m[1] === localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return "Yesterday";
  return "";
}
const fmtFriendly = (s) => { const w = dayWord(s); return w ? `${w}, ${fmtStamp(s).split(", ")[1] || ""}` : fmtStamp(s); };

/* The coloured file-type badge in front of every file and link (the Activity
   Timeline design): red PDF, green X, purple image, blue link, dark GitHub. Fixed
   hues with white glyphs, so they read the same in light and dark themes. */
const KIND = {
  pdf: { color: "#E5484D", text: "PDF" }, sheet: { color: "#1D9A5B", text: "X" }, word: { color: "#2B6CEB", text: "W" },
  slides: { color: "#E8590C", text: "P" }, image: { color: "#7C3AED", icon: "camera" }, video: { color: "#DB2777", icon: "play" },
  zip: { color: "#B7791F", text: "ZIP" }, github: { color: "#1F2328", icon: "branch" }, link: { color: "#0EA5E9", icon: "link" },
  file: { color: "#64748B", icon: "doc" },
};
const EXT = { pdf: "pdf", xls: "sheet", xlsx: "sheet", csv: "sheet", doc: "word", docx: "word", ppt: "slides", pptx: "slides",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", heic: "image",
  mp4: "video", mov: "video", webm: "video", avi: "video", zip: "zip", rar: "zip", "7z": "zip" };
function fileKind(name, url) {
  if (url && /^https?:\/\//i.test(url) && !name) return /github\.com\//i.test(url) ? KIND.github : KIND.link;
  const ext = (/\.([a-z0-9]+)$/i.exec(String(name || "").trim()) || [])[1];
  return KIND[EXT[(ext || "").toLowerCase()]] || KIND.file;
}
function FileBadge({ kind }) {
  return <span className="fbadge" style={{ background: kind.color }} aria-hidden="true">{kind.text ? <b style={{ fontSize: kind.text.length > 1 ? 8.5 : 11 }}>{kind.text}</b> : <Icon n={kind.icon} size={13} stroke={2.4} />}</span>;
}
/* "drive.google.com/file/d/…" — host + path, without the scheme or www. */
const shortUrl = (u) => String(u || "").replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");

/* The same words Odoo puts under its file picker. */
function LargeFileNote({ mb = 50 }) {
  return <small style={{ color: "var(--danger)", fontSize: 12, fontWeight: 600 }}>⚠ Large files take time — keep this tab open until 100%. Max {mb} MB per file. For bigger files, add a Drive or GitHub link instead.</small>;
}
/* One upload in flight: progress state, a tracker for speed, and Cancel. */
function useUpload() {
  const [prog, setProg] = useState(null);
  const ctl = useRef(null);
  const start = (hasFiles) => {
    ctl.current = new AbortController();
    if (!hasFiles) { setProg(null); return { signal: ctl.current.signal, onProgress: undefined }; }
    const track = rateTracker();
    setProg({ loaded: 0, total: 0, pct: 0, speed: 0, eta: Infinity });
    return { signal: ctl.current.signal, onProgress: (l, t) => setProg(track(l, t)) };
  };
  const finish = () => { ctl.current = null; setProg(null); };
  const cancel = () => ctl.current?.abort();
  return { prog, start, finish, cancel };
}

/* ---- same-named file on this task: Replace / Keep both / Cancel ----
   Odoo's _taskFileIndex / _resolveDuplicates / _applyReplacements. */
/* A name with the browser's copy number taken off, lower case: "Guide (1).DOCX"
   → "guide.docx". A file downloaded again is saved as "… (1)", and it is still
   the same document. Odoo's _fileKey. */
const COPY_NO = /\s*\(\d+\)(?=(\.[^.]*)?$)/;
function fileKey(name) {
  let k = String(name || "").trim().toLowerCase();
  while (COPY_NO.test(k)) k = k.replace(COPY_NO, "");
  return k;
}
/* Every file already on the task (progress updates + manuals): byName by the
   exact lower-cased name, byKey by fileKey, so "Guide (1).docx" finds "Guide.docx". */
function taskFileIndex(progress, manuals, manualCan) {
  const byName = new Map();
  const byKey = new Map();
  const put = (name, row) => { const e = { name, ...row }; byName.set(name.toLowerCase(), e); if (!byKey.has(fileKey(name))) byKey.set(fileKey(name), e); };
  for (const p of progress || []) {
    const files = p.files?.length ? p.files : p.has_file ? [{ id: 0, file_name: p.file_name }] : [];
    for (const f of files) put(f.file_name || "", { who: p.employee_name, when: f.uploaded_at || p.create_date, kind: "progress", entry_id: p.id, attachment_id: f.id || 0, can_edit: !!p.can_edit });
  }
  for (const m of manuals || []) {
    const files = m.files?.length ? m.files : m.file_name ? [{ id: 0, file_name: m.file_name }] : [];
    for (const f of files) put(f.file_name || "", { who: m.uploaded_by, when: f.uploaded_at || m.upload_date, kind: "manual", entry_id: m.id, attachment_id: f.id || 0, can_edit: !!manualCan[m.id] });
  }
  return { byName, byKey };
}
/* The same index from /kpi/task/files_index: EVERY file on the task, whoever
   uploaded it. The panel's own lists can't be trusted for this: a developer's
   progress list holds only their own updates, so an admin's file was never
   flagged and no popup appeared. can_edit there is the caller's right to Replace.
   Falls back to the on-screen lists (fallback()) if the route can't answer. */
async function serverFileIndex(kpiId, fallback) {
  try {
    const r = await S.fetchTaskFilesIndex(kpiId);
    if (!r || r.status === false || !Array.isArray(r.files)) return fallback();
    const byName = new Map();
    const byKey = new Map();
    for (const f of r.files) {
      const name = f.file_name || "";
      const e = { name, who: f.who, when: f.uploaded_at, kind: f.kind, entry_id: f.entry_id, attachment_id: f.attachment_id || 0, can_edit: !!f.can_edit };
      byName.set(name.toLowerCase(), e);
      if (!byKey.has(fileKey(name))) byKey.set(fileKey(name), e);
    }
    return { byName, byKey };
  } catch (e) { return fallback(); }
}
/* "report.pdf" → the first of "report (2).pdf", "report (3).pdf"… not taken. An
   existing copy number is dropped first: "report (1).pdf" → "report (2).pdf",
   never "report (1) (2).pdf". */
function freeName(name, taken) {
  let clean = name;
  while (COPY_NO.test(clean)) clean = clean.replace(COPY_NO, "");
  const dot = clean.lastIndexOf(".");
  const base = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  for (let n = 2; ; n += 1) { const c = `${base} (${n})${ext}`; if (!taken.has(c.toLowerCase())) return c; }
}
/* Manual rows carry can_edit only on /kpi/manual/list, not on task details. */
function useManualCan(kpiId, manuals) {
  const [can, setCan] = useState({});
  const ids = (manuals || []).map((m) => m.id).join(",");
  useEffect(() => {
    if (!ids) { setCan({}); return undefined; }
    let live = true;
    S.listManuals(kpiId).then((list) => { if (live) setCan(Object.fromEntries(list.map((m) => [m.id, !!m.can_edit]))); }).catch(() => {});
    return () => { live = false; };
  }, [kpiId, ids]);
  return can;
}
/* Picked files whose name is already on the task (or picked twice), resolved in
   two passes like Odoo's _resolveDuplicates. resolve(picked, idx, alreadyPicked)
   → { files, replace }: the files to add (renamed where kept as a copy) and the
   old files to remove once the upload has succeeded.
     one duplicate      → the single popup: Replace / Keep both / Cancel
     two or more        → ONE popup with a tick per file: Replace all / Replace
                          selected / Cancel. Unticked files are kept as a copy
                          ("name (2).ext"), never dropped; Cancel drops the
                          duplicates and still uploads the new files. */
function useDuplicates() {
  const [ask, setAsk] = useState(null);   /* single: { name, old, free, canReplace, done } */
  const [many, setMany] = useState(null); /* list:   { rows, done } */
  const resolve = async (picked, idx, alreadyPicked = []) => {
    const as = (f, name) => (name === f.name ? f : new File([f], name, { type: f.type, lastModified: f.lastModified }));
    /* Pass 1: which picked files clash, and which of those this user may replace.
       The exact name first, then the same file under a copy number. A second
       pick of a name already picked is a repeat. An old file claimed by an
       earlier pick cannot be replaced twice. */
    const seen = new Set(alreadyPicked.map((f) => f.name.toLowerCase()));
    const claimed = new Set();
    const rows = picked.map((f) => {
      const lower = (f.name || "").toLowerCase();
      const repeat = seen.has(lower);
      seen.add(lower);
      const old = repeat ? null : idx.byName.get(lower) || idx.byKey.get(fileKey(f.name));
      if (!old && !repeat) return { f, lower, dup: false };
      const oldKey = old ? old.name.toLowerCase() : "";
      const canReplace = !!(old && old.can_edit && !claimed.has(oldKey));
      if (canReplace) claimed.add(oldKey);
      return { f, lower, dup: true, old, oldKey, repeat, canReplace, keyOnly: !!old && oldKey !== lower };
    });
    const dups = rows.filter((r) => r.dup);
    /* The decision per duplicate: "replace" | "copy" | "drop". */
    const decide = new Map();
    if (dups.length === 1) {
      const r = dups[0];
      const taken = new Set([...idx.byName.keys(), ...alreadyPicked.map((f) => f.name.toLowerCase()), ...rows.filter((x) => !x.dup).map((x) => x.lower)]);
      const free = taken.has(r.lower) ? freeName(r.f.name, taken) : r.f.name;
      const ans = await new Promise((done) => setAsk({ name: r.f.name, old: r.old, keyOnly: r.keyOnly, free, canReplace: r.canReplace, done }));
      setAsk(null);
      decide.set(r, ans === "replace" && r.canReplace ? "replace" : ans === "keep" ? "copy" : "drop");
    } else if (dups.length > 1) {
      const ans = await new Promise((done) => setMany({ rows: dups, done }));
      setMany(null);
      for (const r of dups) {
        decide.set(r, !ans ? "drop"
          : r.canReplace && (ans.mode === "all" || (ans.mode === "selected" && ans.ticked.has(r))) ? "replace" : "copy");
      }
    }
    /* Pass 2, in picked order. A copy keeps its own name when nothing has it,
       else the next free "(n)"; names in use grow as they are taken. A replace is
       sent under the OLD file's name, so no "(1)" names pile up, and the old one
       is removed once this upload succeeds. */
    const taken = new Set([...idx.byName.keys(), ...alreadyPicked.map((f) => f.name.toLowerCase()), ...rows.filter((r) => !r.dup).map((r) => r.lower)]);
    const files = [];
    const replace = [];
    for (const r of rows) {
      if (!r.dup) { files.push(r.f); continue; }
      const what = decide.get(r);
      if (what === "replace") {
        files.push(as(r.f, r.old.name));
        replace.push({ key: r.oldKey, kind: r.old.kind, entry_id: r.old.entry_id, attachment_id: r.old.attachment_id });
      } else if (what === "copy") {
        const name = taken.has(r.lower) ? freeName(r.f.name, taken) : r.f.name;
        taken.add(name.toLowerCase());
        files.push(as(r.f, name));
      }
      /* "drop": left out of this upload. */
    }
    return { files, replace };
  };
  const dialog = ask && (
    <Modal open onClose={() => ask.done(null)} title="File already exists" width={460}
      footer={<>
        <Button kind="ghost" onClick={() => ask.done(null)}>Cancel</Button>
        <Button kind={ask.canReplace ? "default" : "primary"} onClick={() => ask.done("keep")}>Keep both</Button>
        {ask.canReplace && <Button kind="danger" onClick={() => ask.done("replace")}>Replace</Button>}
      </>}>
      {ask.old ? (
        <>
          {ask.keyOnly
            ? <p style={{ margin: 0 }}><b>{ask.name}</b> looks like <b>{ask.old.name}</b>, which is already on this task.</p>
            : <p style={{ margin: 0 }}><b>{ask.name}</b> is already on this task.</p>}
          <p className="mini" style={{ margin: "4px 0 0" }}>Uploaded by {ask.old.who || "someone"} on {fmtStamp(ask.old.when) || "an earlier date"}.</p>
          <p style={{ margin: "10px 0 0" }}>
            {ask.canReplace ? <>Replace it (the new file is saved as <b>{ask.old.name}</b>), or keep both</> : "Keep both"}{ask.free !== ask.name ? <> (the new one is saved as <b>{ask.free}</b>)</> : null}?
          </p>
          {!ask.old.can_edit && <p className="mini" style={{ margin: "6px 0 0" }}>Only the uploader or an admin can replace it.</p>}
        </>
      ) : (
        <p style={{ margin: 0 }}>Two of the picked files are named <b>{ask.name}</b>. Keep both{ask.free !== ask.name ? <> (the second is saved as <b>{ask.free}</b>)</> : null}?</p>
      )}
    </Modal>
  );
  return { resolve, dialog: dialog || (many && <ManyDuplicates rows={many.rows} done={many.done} />) };
}

/* Two or more picked files already on the task: ONE popup, a tick per file. */
function ManyDuplicates({ rows, done }) {
  const [ticked, setTicked] = useState(() => new Set(rows.filter((r) => r.canReplace)));
  const any = rows.some((r) => r.canReplace);
  const set = (r, on) => setTicked((t) => { const n = new Set(t); if (on) n.add(r); else n.delete(r); return n; });
  return (
    <Modal open onClose={() => done(null)} title={`${rows.length} files are already on this task`} width={520}
      footer={any ? <>
        <Button kind="ghost" onClick={() => done(null)}>Cancel</Button>
        <Button onClick={() => done({ mode: "all" })} style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Replace all</Button>
        <Button kind="danger" onClick={() => done({ mode: "selected", ticked })}>Replace selected</Button>
      </> : <>
        <Button kind="ghost" onClick={() => done(null)}>Cancel</Button>
        <Button kind="primary" onClick={() => done({ mode: "copies" })}>Keep all as copies</Button>
      </>}>
      <p style={{ margin: 0 }}>{any
        ? "Tick the files to replace. Unticked files are kept as a copy, saved with a (2), (3)… name."
        : "You can not replace these, so they will be kept as copies, saved with a (2), (3)… name."}</p>
      {any && (
        <div className="mini" style={{ margin: "8px 0 4px" }}>
          <button type="button" className="link" onClick={() => setTicked(new Set(rows.filter((r) => r.canReplace)))} style={LINKBTN}>Tick all</button>
          {" · "}
          <button type="button" className="link" onClick={() => setTicked(new Set())} style={LINKBTN}>Untick all</button>
        </div>
      )}
      <div style={{ maxHeight: 260, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, border: "1px solid var(--border)", borderRadius: 10, padding: 6 }}>
        {rows.map((r, i) => (
          <label key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "6px 8px", borderRadius: 8, cursor: r.canReplace ? "pointer" : "default", opacity: r.canReplace ? 1 : 0.85 }}>
            <input type="checkbox" checked={r.canReplace && ticked.has(r)} disabled={!r.canReplace} onChange={(e) => set(r, e.target.checked)}
              style={{ width: 15, height: 15, marginTop: 2, accentColor: "var(--danger)", flex: "none" }} />
            <span style={{ minWidth: 0 }}>
              <b style={{ display: "block", overflowWrap: "anywhere" }}>{r.f.name}</b>
              <small className="mini" style={{ display: "block" }}>
                {r.repeat ? "Picked twice in this upload"
                  : <>{r.keyOnly ? <>Looks like “{r.old.name}”</> : "Already on this task"} · uploaded by {r.old.who || "someone"} on {fmtStamp(r.old.when) || "an earlier date"}</>}
              </small>
              {!r.canReplace && (
                <small style={{ display: "block", color: "var(--lz-paused, #B45309)", fontWeight: 600 }}>
                  {r.repeat || !r.old ? "It will be kept as a copy." : "Only the uploader or an admin can replace this. It will be kept as a copy."}
                </small>
              )}
            </span>
          </label>
        ))}
      </div>
    </Modal>
  );
}
const LINKBTN = { background: "none", border: 0, padding: 0, color: "var(--brand)", fontWeight: 700, cursor: "pointer", font: "inherit" };
/* After a successful upload: remove the old files the user chose to Replace —
   only those whose new namesake really went up, extra files before entry files
   (removing an entry's own file promotes the next one, which would move an id
   that is still to be removed). Returns the ones that could not be removed. */
async function applyReplacements(replace, uploaded) {
  const sent = new Set((uploaded || []).map((f) => f.name.toLowerCase()));
  const list = (replace || []).filter((r) => sent.has(r.key)).sort((a, b) => (b.attachment_id ? 1 : 0) - (a.attachment_id ? 1 : 0));
  const failed = [];
  for (const r of list) {
    try { const res = await S.removeEntryFile(r.kind, r.entry_id, r.attachment_id); if (!res?.status) failed.push(res?.message || r.key); }
    catch (e) { failed.push(r.key); }
  }
  return failed;
}

/* ---- a link already on this task (Odoo's _taskLinkIndex / linkDup) ----
   Every link on the task by githubKey (no scheme or www., no trailing / or .git,
   lower case): GitHub links, Drive & Links (related links) and manual links. */
function taskLinkIndex(d) {
  const idx = new Map();
  const put = (url, where, who, when) => { const k = githubKey(url); if (k && !idx.has(k)) idx.set(k, { where, who, when }); };
  for (const g of d?.github || []) put(g.github_url, `GitHub, branch ${g.branch_name || "—"}`, g.employee_name, g.create_date);
  for (const l of d?.links || []) put(l.url, "related link", l.added_by, l.added_date);
  for (const m of d?.manuals || []) for (const u of S.parseLinks(m.related_links)) put(u, "manual link", m.uploaded_by, m.upload_date);
  return idx;
}
/* The red line under a Related Links box: the first link that is already on the
   task, or typed twice in the box. "" when there is nothing to say. */
function linkDupMessage(text, idx) {
  const seen = new Set();
  for (const u of splitLinks(text)) {
    const k = githubKey(u);
    if (!k || !k.includes(".")) continue; /* a typed word, not a link yet */
    if (seen.has(k)) return "Already added to this list.";
    seen.add(k);
    const hit = idx.get(k);
    if (hit) return `Already on this task (${hit.where}): added by ${hit.who || "someone"} on ${fmtStamp(hit.when) || "an earlier date"}.`;
  }
  return "";
}
const DupLine = ({ text }) => (text ? <small style={{ color: "var(--danger)", fontSize: 12, fontWeight: 700 }}>⚠ {text}</small> : null);
/* What is wrong with a link box's text while it is typed / pasted ('' = fine).
   Several links separated by spaces; each must be a real web link. Same rule
   as Odoo's KPI details (kpi_action.js linkBad). */
export function linkProblem(text) {
  for (const w of String(text || "").trim().split(/s+/).filter(Boolean)) {
    let u = null;
    try { u = new URL(w); } catch { u = null; }
    if (!u || !/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return `“${w.length > 40 ? w.slice(0, 40) + "…" : w}” is not a web link. Links must start with https:// — e.g. https://drive.google.com/…`;
  }
  return "";
}

/* ---- small shared bits ---- */
/* onPick(files) lets the caller vet a pick (the duplicate check) before it is added. */
function FilePicker({ files, setFiles, onPick, accept, disabled, label = "Attach files" }) {
  const ref = useRef(null);
  return (
    <>
      <input ref={ref} type="file" multiple accept={accept} hidden onChange={(e) => { const add = [...(e.target.files || [])]; e.target.value = ""; if (onPick) onPick(add); else setFiles((f) => [...f, ...add]); }} />
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
/* Odoo's upload readout: the percent on the bar, then bytes moved, speed and
   time left — a bar alone can't tell "slow" from "stalled" on a 40 MB file. */
function UploadBar({ prog, onCancel }) {
  const { pct, loaded, total, speed, eta } = prog;
  const saving = total > 0 && pct >= 100;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%" }}>
      <span className="prog" style={{ height: 18, borderRadius: 9, position: "relative" }}>
        <i style={{ width: `${pct}%`, transition: "width .2s" }} />
        <b style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 11, color: pct > 50 ? "#fff" : "var(--text)" }}>{pct}%</b>
      </span>
      <span className="mini" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span>{saving ? "Saving…" : total ? progressLine({ loaded, total, speed, eta }) : "Starting upload…"}</span>
        {!saving && onCancel && <button type="button" className="link" onClick={onCancel} style={{ marginLeft: "auto", background: "none", border: 0, padding: 0, color: "var(--danger)", fontWeight: 700, cursor: "pointer", font: "inherit" }}>Cancel</button>}
      </span>
    </div>
  );
}
const Err = ({ children }) => (children ? <small className="err" style={{ color: "var(--danger)", fontSize: 12.5, fontWeight: 700 }}>{children}</small> : null);
/* An entry's files: the first is served by the entry's own route (id 0), the rest
   by /kpi/attachment/download — `url` already says which. */
function FileChips({ files, viewFirst, fallbackAt }) {
  if (!files?.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
      {files.map((f) => <FileChip key={f.id || f.url} f={f} to={f.id === 0 && viewFirst ? viewFirst : f.url} fallbackAt={fallbackAt} />)}
    </div>
  );
}
/* One file: its type badge, its name, and when it was saved in small type under
   it. Each file keeps its own time (uploaded_at): a file added later to an entry
   is not as old as the entry. */
function FileChip({ f, to, fallbackAt }) {
  const at = fmtFriendly(f.uploaded_at || fallbackAt);
  return (
    <a className="frow" href={href(to)} target="_blank" rel="noreferrer" title={f.file_name}>
      <FileBadge kind={fileKind(f.file_name)} />
      <span style={{ minWidth: 0 }}><span className="fname" style={{ display: "block" }}>{f.file_name || "file"}</span>{at && <span className="fsub">Saved {at}</span>}</span>
    </a>
  );
}
/* Related links, as rows like the files: a GitHub or link badge and the URL
   without its scheme. */
function LinkList({ links }) {
  if (!links?.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
      {links.map((l, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
          <a className="frow" href={l} target="_blank" rel="noreferrer" title={l} style={{ flex: 1 }}>
            <FileBadge kind={fileKind("", l)} /><span className="fname">{shortUrl(l)}</span>
          </a>
          <CopyLink url={l} />
        </div>
      ))}
    </div>
  );
}

/* ---- asking the manager (kpi.doubt) ----
   A developer never talks to the client: a question about a task goes to the
   manager, who answers it, takes it to the client, makes a meeting or says not
   now (Approvals › Questions). The developer sees the answer here. */
export function ManagerQuestions({ kpiId, canAsk }) {
  const flags = useFlags();
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("question");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => P.taskDoubts(kpiId).then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, [kpiId]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await P.createDoubt({ kpiId, kind, question: text.trim() });
      flags.ok("Sent to the manager.");
      setText(""); setKind("question"); setOpen(false); load();
      window.dispatchEvent(new CustomEvent("kpi:approvals"));
    } catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  if (!canAsk && !(list && list.length)) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <h3 style={{ display: "flex", alignItems: "center", margin: 0 }}>Questions to the manager{list?.length ? ` · ${list.length}` : ""}
        {canAsk && !open && <span style={{ marginLeft: "auto" }}><Button size="sm" kind="ghost" icon="people" onClick={() => setOpen(true)}>Ask the manager</Button></span>}</h3>
      {open && (
        <div className="reveal" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Field label="What is it" required><Tabs items={P.DOUBT_KINDS} value={kind} onChange={setKind} /></Field>
          <Field label={kind === "question" ? "Your question" : "What the meeting is for"} required hint="It goes to the manager, not the client. The manager decides what reaches the client.">
            <span className="input ta" style={{ height: 72 }}><textarea value={text} autoFocus onChange={(e) => setText(e.target.value)} style={TA} /></span>
          </Field>
          <div className="pillset"><Button size="sm" kind="ghost" onClick={() => { setOpen(false); setText(""); }}>Cancel</Button><Button size="sm" kind="primary" busy={busy} disabled={!text.trim()} onClick={send}>Send to the manager</Button></div>
        </div>
      )}
      {(list || []).map((d) => {
        const [tone, label] = P.DOUBT_STATES[d.state] || ["neutral", d.state];
        return (
          <div key={d.id} className="comment" style={{ alignItems: "flex-start" }}>
            <Icon n="people" size={16} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <b>{P.doubtKindLabel(d.kind)}</b><small>{Array.isArray(d.raised_by_id) ? d.raised_by_id[1] : ""}</small>
                <Lozenge tone={tone} style={{ textTransform: "none", marginLeft: "auto" }}>{label}</Lozenge>
              </div>
              <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "2px 0 0" }}>{d.question}</p>
              {d.answer && <p className="mini" style={{ margin: "4px 0 0", color: "var(--pri-regular)", whiteSpace: "pre-wrap" }}><b>{Array.isArray(d.answered_by_id) ? d.answered_by_id[1] : "Manager"}:</b> {d.answer}</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* The client's own first wording and how many times it was corrected
   (kra.kpi.original_client_text / correction_round), when there is any. */
export function ClientWording({ kpiId }) {
  const [c, setC] = useState(null);
  useEffect(() => { let live = true; P.taskCorrection(kpiId).then((r) => { if (live) setC(r); }).catch(() => {}); return () => { live = false; }; }, [kpiId]);
  if (!c || (!c.original_client_text && !(c.correction_round > 0))) return null;
  return (
    <div className="sec">
      <h3>Client&apos;s original wording</h3>
      {c.original_client_text && <p style={{ whiteSpace: "pre-wrap" }}>{c.original_client_text}</p>}
      {c.correction_round > 0 && <p className="mini" style={{ whiteSpace: "pre-wrap" }}>Corrected {c.correction_round}×{c.last_correction_text ? ` — latest: ${c.last_correction_text}` : ""}</p>}
    </div>
  );
}

/* Shown in place of the add-forms until the task has been started (Odoo's wording). */
export function NotStartedNote() {
  return (
    <div className="callout" style={{ background: "var(--over-bg)", borderColor: "var(--danger)", color: "var(--danger)", alignItems: "center", fontWeight: 700 }}>
      <Icon n="warn" size={16} /><span>Start this task to add progress updates, files, manuals and GitHub links.</span>
    </div>
  );
}

/* ---- progress updates ---- */
export function ProgressComposer({ kpiId, d, onChanged }) {
  const flags = useFlags();
  const [summary, setSummary] = useState("");
  const [links, setLinks] = useState("");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const up = useUpload();
  const [err, setErr] = useState("");
  const dups = useDuplicates();
  const manualCan = useManualCan(kpiId, d?.manuals);
  const replaceRef = useRef([]);
  const linkDup = linkDupMessage(links, taskLinkIndex(d));
  const pick = async (picked) => {
    const idx = await serverFileIndex(kpiId, () => taskFileIndex(d?.progress, d?.manuals, manualCan));
    const { files: ok, replace } = await dups.resolve(picked, idx, files);
    replaceRef.current = [...replaceRef.current, ...replace];
    if (ok.length) setFiles((f) => [...f, ...ok]);
  };
  const post = async () => {
    if (!summary.trim()) return;
    setBusy(true); setErr("");
    const { signal, onProgress } = up.start(files.length > 0);
    try {
      const res = await S.submitProgress(kpiId, { summary: summary.trim(), links: splitLinks(links), files }, onProgress, signal);
      S.assertOk(res, "Could not save the update.");
      /* Replace = upload first, then take the old file off: a failed upload
         must not have cost the old one. */
      const failed = await applyReplacements(replaceRef.current, files);
      replaceRef.current = [];
      setSummary(""); setLinks(""); setFiles([]);
      flags.ok(files.length ? `Update posted with ${files.length} file${files.length === 1 ? "" : "s"}.` : "Update posted.");
      if (failed.length) flags.warn(`The new file was saved, but the old one could not be removed: ${failed.join("; ")}`);
      onChanged?.();
    } catch (e) { if (e.message === UPLOAD_CANCELLED) flags.warn(UPLOAD_CANCELLED); else setErr(e.message); } finally { setBusy(false); up.finish(); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Field label="Progress summary" required>
        <span className="input ta" style={{ height: 72 }}><textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Describe the work done: issues fixed, next steps…" disabled={busy} style={TA} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) post(); }} /></span>
      </Field>
      <Input icon="link" value={links} onChange={(e) => setLinks(e.target.value)} disabled={busy} placeholder="Links (optional) — Drive, GitHub, … separated by spaces" style={linkProblem(links) ? { borderColor: "var(--danger)" } : undefined} />
      <DupLine text={linkProblem(links)} />
      {/* A link already on the task blocks posting until it is taken out, as Odoo's Add Link does. */}
      <DupLine text={linkDup} />
      <div className="pillset" style={{ alignItems: "center" }}>
        <FilePicker files={files} setFiles={setFiles} onPick={pick} disabled={busy} />
        <span style={{ marginLeft: "auto" }}><Button kind="primary" size="sm" busy={busy} disabled={!summary.trim() || !!linkDup || !!linkProblem(links)} onClick={post}>Post</Button></span>
      </div>
      <LargeFileNote mb={50} />
      {dups.dialog}
      {up.prog && <UploadBar prog={up.prog} onCancel={up.cancel} />}
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
          <b>{p.employee_name}</b><small title={fmtStamp(p.create_date)}>{fmtFriendly(p.create_date)}</small>
          {/* "18:20 · Edited Yesterday", as in the design and on the Odoo board. */}
          {p.edited_at && <small title={`Last edited ${fmtStamp(p.edited_at)}`} style={{ color: "var(--lz-paused, #B45309)", fontWeight: 700, fontStyle: "italic" }}>· Edited {dayWord(p.edited_at) || fmtStamp(p.edited_at)}</small>}
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
            <Input icon="link" value={edit.links} onChange={(e) => setEdit((v) => ({ ...v, links: e.target.value }))} placeholder="Links, separated by spaces" style={linkProblem(edit.links) ? { borderColor: "var(--danger)" } : undefined} />
            <DupLine text={linkProblem(edit.links)} />
            {p.has_file && <label className="chk"><input type="checkbox" checked={edit.clearFile} onChange={(e) => setEdit((v) => ({ ...v, clearFile: e.target.checked }))} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} />Remove the file “{p.file_name || "file"}”</label>}
            <div className="pillset"><Button size="sm" kind="ghost" onClick={() => { setEdit(null); setErr(""); }}>Cancel</Button><Button size="sm" kind="primary" busy={busy} disabled={!edit.summary.trim() || !!linkProblem(edit.links)} onClick={save}>Save</Button></div>
            <Err>{err}</Err>
          </div>
        ) : (
          <>
            <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{p.summary}</p>
            <FileChips files={p.files?.length ? p.files : p.has_file ? [{ id: 0, file_name: p.file_name, url: `/kpi/progress/download?progress_id=${p.id}` }] : []} viewFirst={`/kpi/progress/view?progress_id=${p.id}`} fallbackAt={p.create_date} />
            <LinkList links={links} />
          </>
        )}
      </div>
    </div>
  );
}

/* ---- files tab: attachments, manuals, GitHub, links ---- */
/* canAdd: the task has been started. Before that, what is already here stays
   visible (read-only) and the add controls are hidden, as on the Odoo board. */
export function FilesTab({ kpiId, d, canAdd = true, canManageGithub, onChanged }) {
  const manuals = d.manuals || [];
  const linkIdx = taskLinkIndex(d);
  /* Files the client attached when raising the task get their own list on top,
     apart from what the team attached to its updates. */
  const clientFiles = (d.files || []).filter((f) => f.from_client);
  const teamFiles = (d.files || []).filter((f) => !f.from_client);
  /* The old-DB KPI Details card lives in the Client tab (ClientTab.jsx), with
     every time the client sent the task. */
  const fileRow = (f) => (
    <div key={`f${f.id}`} className="kv" style={{ padding: "6px 0" }}>
      <FileBadge kind={fileKind(f.file_name)} />
      <a className="val" href={href(`/kpi/progress/view?progress_id=${f.id}`)} target="_blank" rel="noreferrer" style={{ ...ELLIPSIS, textDecoration: "none", minWidth: 0 }}>{f.file_name || "file"}</a>
      <span className="right mini">{f.uploaded_by} · {fmtFriendly(f.upload_date)}<a className="icon-btn" href={href(`/kpi/progress/download?progress_id=${f.id}`)} title="Download" aria-label="Download"><Icon n="download" size={15} /></a></span>
    </div>
  );
  return (
    <div className="sec" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {clientFiles.length > 0 && (
        <div>
          <h3>📎 From the client · {clientFiles.length}</h3>
          {clientFiles.map(fileRow)}
        </div>
      )}
      {!canAdd && <NotStartedNote />}
      {(canAdd || manuals.length > 0) && <Manuals kpiId={kpiId} manuals={manuals} progress={d.progress || []} linkIdx={linkIdx} canAdd={canAdd} onChanged={onChanged} />}
      <Github kpiId={kpiId} github={d.github || []} linkIdx={linkIdx} canAdd={canAdd} canDelete={canManageGithub} onChanged={onChanged} />
      <div>
        <h3>Attached to updates{teamFiles.length ? ` · ${teamFiles.length}` : ""}</h3>
        {teamFiles.map(fileRow)}
        {!teamFiles.length && <span className="mini">No files on progress updates yet.</span>}
      </div>
      {(d.links || []).length > 0 && (
        <div>
          <h3>Links · {d.links.length}</h3>
          {d.links.map((l, i) => (
            <div key={`l${i}`} className="kv" style={{ padding: "6px 0" }}>
              <FileBadge kind={fileKind("", l.url)} />
              <a className="val" href={l.url} target="_blank" rel="noreferrer" style={{ ...ELLIPSIS, textDecoration: "none", minWidth: 0 }} title={l.url}>{shortUrl(l.url)}</a>
              <CopyLink url={l.url} />
              <span className="right mini" style={{ flex: "none" }}>{l.kind ? `${l.kind} · ` : ""}{l.added_by}{l.added_date ? ` · ${fmtFriendly(l.added_date)}` : ""}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Manuals({ kpiId, manuals, progress, linkIdx, canAdd = true, onChanged }) {
  const flags = useFlags();
  const dlg = useDialogs();
  const can = useManualCan(kpiId, manuals); /* manual id → can_edit, from /kpi/manual/list */
  const dups = useDuplicates();
  const replaceRef = useRef([]);
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState([]);
  const [desc, setDesc] = useState("");
  const [mlinks, setMlinks] = useState("");
  const mlinkDup = linkDupMessage(mlinks, linkIdx || new Map());
  const [busy, setBusy] = useState(false);
  const up = useUpload();
  const [err, setErr] = useState("");
  const pick = async (picked) => {
    const idx = await serverFileIndex(kpiId, () => taskFileIndex(progress, manuals, can));
    const { files: ok, replace } = await dups.resolve(picked, idx, files);
    replaceRef.current = [...replaceRef.current, ...replace];
    if (ok.length) setFiles((f) => [...f, ...ok]);
  };
  const send = async () => {
    setBusy(true); setErr("");
    const { signal, onProgress } = up.start(true);
    try {
      S.assertOk(await S.uploadManual(kpiId, { files, description: desc.trim(), links: splitLinks(mlinks) }, onProgress, signal), "Could not upload the manual.");
      const failed = await applyReplacements(replaceRef.current, files);
      replaceRef.current = [];
      flags.ok("Manual uploaded."); setFiles([]); setDesc(""); setMlinks(""); setOpen(false); onChanged?.();
      if (failed.length) flags.warn(`The new file was saved, but the old one could not be removed: ${failed.join("; ")}`);
    } catch (e) { if (e.message === UPLOAD_CANCELLED) flags.warn(UPLOAD_CANCELLED); else setErr(e.message); } finally { setBusy(false); up.finish(); }
  };
  const remove = async (m) => {
    if (!(await dlg.confirm({ title: "Delete this manual?", text: `${m.file_name || "The manual"} and every file on it are removed.`, confirmLabel: "Delete", danger: true }))) return;
    try { S.assertOk(await S.deleteManual(m.id), "Could not delete."); flags.ok("Manual deleted."); onChanged?.(); }
    catch (e) { flags.err(e.message); }
  };
  return (
    <div>
      <h3 style={{ display: "flex", alignItems: "center" }}>User manuals{manuals.length ? ` · ${manuals.length}` : ""}{!open && canAdd && <span style={{ marginLeft: "auto" }}><Button size="sm" kind="ghost" icon="upload" onClick={() => setOpen(true)}>Upload</Button></span>}</h3>
      {open && canAdd && (
        <div className="reveal" style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
          <Field label="Upload manual file(s)" required>
            <div className="pillset" style={{ alignItems: "center" }}><FilePicker files={files} setFiles={setFiles} onPick={pick} accept=".pdf,.doc,.docx" disabled={busy} label="Choose PDF / DOC / DOCX" /></div>
          </Field>
          {dups.dialog}
          <Input value={desc} onChange={(e) => setDesc(e.target.value)} disabled={busy} placeholder="What is this manual for? (optional)" />
          <Input icon="link" value={mlinks} onChange={(e) => setMlinks(e.target.value)} disabled={busy} placeholder="Related links (optional) — separated by spaces" style={linkProblem(mlinks) ? { borderColor: "var(--danger)" } : undefined} />
          <DupLine text={linkProblem(mlinks)} />
          <DupLine text={mlinkDup} />
          <LargeFileNote mb={25} />
          {up.prog && <UploadBar prog={up.prog} onCancel={up.cancel} />}
          <div className="pillset"><Button size="sm" kind="ghost" disabled={busy} onClick={() => { setOpen(false); setFiles([]); setErr(""); }}>Cancel</Button><Button size="sm" kind="primary" busy={busy} disabled={!files.length || !!mlinkDup || !!linkProblem(mlinks)} onClick={send}>Upload</Button></div>
          <Err>{err}</Err>
        </div>
      )}
      {manuals.map((m) => (
        <div key={`m${m.id}`} className="kv" style={{ padding: "6px 0", alignItems: "flex-start" }}>
          <Icon n="book" size={16} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {(m.files?.length ? m.files : [{ id: 0, file_name: m.file_name || "Manual", url: `/kpi/manual/download/${m.id}` }]).map((f) => (
                <FileChip key={f.id || f.url} f={f} to={f.id === 0 ? `/kpi/manual/view/${m.id}` : f.url} fallbackAt={m.upload_date} />
              ))}
            </div>
            {m.reason && <p className="mini" style={{ margin: "4px 0 0" }}>{m.reason}</p>}
            <LinkList links={S.parseLinks(m.related_links)} />
            <small className="mini">{m.uploaded_by}{m.upload_date ? ` · ${fmtFriendly(m.upload_date)}` : ""}</small>
          </div>
          {can[m.id] && <IconButton icon="trash" label="Delete manual" size={14} onClick={() => remove(m)} />}
        </div>
      ))}
      {!manuals.length && !open && <span className="mini">No manual uploaded yet.</span>}
    </div>
  );
}

/* The same reduction as _github_key in kra_api.py (and _githubKey on the Odoo
   board): no scheme, no www., no trailing / or .git, lower case. */
const githubKey = (url) => {
  let u = String(url || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  if (u.endsWith(".git")) u = u.slice(0, -4);
  return u.replace(/\/+$/, "");
};
/* A real GitHub repository link: github.com/<owner>/<repo>. A Drive or other
   link, or a bare github.com, is not — and gets no "main" pill. */
const isGithubRepo = (url) => /^github\.com\/[^/]+\/[^/]+/.test(githubKey(url));
function githubDup(links, url, branch) {
  const repo = githubKey(url);
  if (!repo || !repo.includes("github.com/")) return null;
  const b = String(branch || "").trim().toLowerCase();
  const same = (links || []).filter((g) => githubKey(g.github_url) === repo);
  if (!same.length) return null;
  const exact = b && same.find((g) => String(g.branch_name || "").trim().toLowerCase() === b);
  const g = exact || same[0];
  const when = fmtStamp(g.create_date);
  return exact
    ? { exact: true, text: `Already linked by ${g.employee_name || "someone"} on ${when} (branch ${g.branch_name}).` }
    : { exact: false, text: `This repo is already linked on branch ${same.map((x) => x.branch_name).join(", ")} (${g.employee_name || "someone"}, ${when}). A different branch is fine.` };
}

function Github({ kpiId, github, linkIdx, canAdd = true, canDelete, onChanged }) {
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
  /* Already on this task? Checked while typing/pasting, as on the Odoo board:
     same repo + branch blocks Add; the same repo on another branch is only said. */
  const dup = githubDup(github, url, branch);
  const key = githubKey(url);
  const hit = url.trim() ? (linkIdx || new Map()).get(key) : null;
  const already = hit ? `Already on this task (${hit.where}): added by ${hit.who || "someone"} on ${fmtStamp(hit.when) || "an earlier date"}.` : "";
  const isRepo = isGithubRepo(url);
  /* The one line under the form, as on the Odoo board (githubDup's levels):
     - a GitHub repo already linked on this branch: red, Add disabled (dup.exact);
     - the same repo on another branch: grey, Add enabled (dup, not exact);
     - a GitHub repo already on the task as a related or manual link: red, Add
       enabled, because adding its branch is fine;
     - not a GitHub link at all: red and Add disabled, because this form takes
       GitHub repositories only. If it is already on the task it says where;
       otherwise it says where such links go. */
  const relDup = !dup && key.startsWith("github.com/") && hit && !hit.where.startsWith("GitHub") ? already : "";
  const notGit = !url.trim() ? ""
    : !key.includes(".") || /\s/.test(url.trim()) ? "This is not a web link — it should look like https://github.com/username/repository"
    : !key.startsWith("github.com/") ? (already || "Only GitHub repository links can be added here. Add other links under Related Links.")
    : !/^github\.com\/[^/]+\/[^/]+/.test(key) ? "Not a repository link — it should look like https://github.com/username/repository"
    : "";
  /* A pasted ".../tree/<branch>" URL is split into the repo root + that branch
     (unless one is already typed), as the phone does. On paste and on blur, not
     per keystroke: mid-typing, "…/tree/m" would match and trim the URL early. */
  const splitTree = (raw) => {
    const r = resolveGithubLink(raw, branch);
    if (r.url !== String(raw || "").trim()) { setUrl(r.url); if (!branch.trim()) setBranch(r.branch); return true; }
    return false;
  };
  return (
    <div>
      <h3 style={{ display: "flex", alignItems: "center" }}>GitHub{github.length ? ` · ${github.length}` : ""}{!open && canAdd && <span style={{ marginLeft: "auto" }}><Button size="sm" kind="ghost" icon="plus" onClick={() => setOpen(true)}>Add link</Button></span>}</h3>
      {open && canAdd && (
        <div className="reveal" style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
          <Field label="Repository URL" required hint="Only GitHub repository URLs are accepted">
            <Input value={url} autoFocus onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/username/repository"
              onPaste={(e) => { const t = e.clipboardData?.getData("text"); if (t && splitTree(t)) e.preventDefault(); }}
              onBlur={() => splitTree(url)} />
          </Field>
          <Field label="Branch" required>
            <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main, feature/new-module, …" onKeyDown={(e) => { if (e.key === "Enter" && url.trim() && branch.trim()) add(); }} />
          </Field>
          {/* The branch is required and is "main" most of the time, so it is one
              click away, as in Odoo and the app. Only once there is a repo, and
              only while the box is empty, so it gets out of the way of a real
              branch. A pill, not a silent default: "main" is seen before saving. */}
          {isRepo && !branch.trim() && (
            <div className="pillset">
              <button type="button" className="chip-sm" onClick={() => setBranch("main")} title="Use the main branch"
                style={{ ...CHIP, border: "1px solid var(--border)", cursor: "pointer", font: "inherit", fontSize: 12, fontWeight: 700 }}>
                <Icon n="branch" size={13} />main
              </button>
            </div>
          )}
          {dup && <small style={{ color: dup.exact ? "var(--danger)" : "var(--subtle)", fontWeight: dup.exact ? 700 : 500, fontSize: 12 }}>{dup.exact ? "⚠ " : "ⓘ "}{dup.text}</small>}
          <DupLine text={relDup || notGit} />
          <div className="pillset"><Button size="sm" kind="ghost" onClick={() => { setOpen(false); setErr(""); }}>Cancel</Button><Button size="sm" kind="primary" busy={busy} disabled={!url.trim() || !branch.trim() || !!dup?.exact || !!notGit} onClick={add}>Add</Button></div>
          <Err>{err}</Err>
        </div>
      )}
      {github.map((g) => (
        <div key={`g${g.id}`} className="kv" style={{ padding: "6px 0" }}>
          <FileBadge kind={KIND.github} />
          <a className="val" href={g.github_url} target="_blank" rel="noreferrer" title={g.github_url} style={{ ...ELLIPSIS, textDecoration: "none", minWidth: 0 }}>{g.github_url.replace(/^https?:\/\/(www\.)?github\.com\//i, "")}</a>
          <CopyLink url={g.github_url} />
          <span className="right mini" style={{ flex: "none" }}>{g.branch_name && <span className="ref">{g.branch_name}</span>}{g.employee_name}{g.create_date ? ` · ${fmtFriendly(g.create_date)}` : ""}{canDelete && <IconButton icon="trash" label="Remove link" size={14} onClick={() => remove(g)} />}</span>
        </div>
      ))}
      {!github.length && !open && <span className="mini">No GitHub link yet.</span>}
    </div>
  );
}

/* ---- history ---- */
const KINDS = [{ key: "all", label: "All" }, { key: "pause", label: "Pause / resume" }, { key: "heading", label: "Heading" }, { key: "time", label: "Time" }];
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
  if (a.event === "time_reduced") return `${p.date}: ${p.from} → ${p.to} (−${p.reduced})${p.reason ? ` — ${p.reason}` : ""}`;
  if (p.from != null && p.to != null && typeof p.from !== "object") return `${p.from} → ${p.to}${p.reason ? ` — ${p.reason}` : ""}`;
  return p.reason || p.note || p.message || p.error || "";
}
/* `at` is already in the user's time zone ("2026-10-23 12:20:56"), so its
   first 10 characters are the local day. */
const histYmd = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
function histDay(key) {
  if (!key) return "No date";
  const now = new Date();
  if (key === histYmd(now)) return "Today";
  if (key === histYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return "Yesterday";
  const [y, m, dd] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, dd);
  return Number.isNaN(dt.getTime()) ? key : dt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/* One day of a history list, closed until tapped: "▸ Today · 6 entries"
   (Odoo's Activity popup). Shared by the History tab and "Everything on this task". */
function DayRow({ label, count, open, onToggle }) {
  return (
    <button type="button" aria-expanded={open} onClick={onToggle}
      style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", border: 0, borderBottom: "1px solid var(--border, #e9edef)", background: "none", padding: "8px 2px", font: "inherit", fontWeight: 600, color: "inherit", textAlign: "left", cursor: "pointer" }}>
      <span aria-hidden="true" style={{ width: 12, color: "var(--subtle)" }}>{open ? "▾" : "▸"}</span>
      <span style={{ flex: 1 }}>{label}</span>
      <span className="mini">{count} entr{count === 1 ? "y" : "ies"}</span>
    </button>
  );
}

export function HistoryTab({ kpiId, d }) {
  const [kind, setKind] = useState("all");
  const [log, setLog] = useState(null); /* {activity_log, activity_total, activity_limit} for a filtered kind */
  const [err, setErr] = useState("");
  const [tries, setTries] = useState(0); /* Retry after a dropped request reloads the log */
  const [all, setAll] = useState(false);
  /* Day rows the person opened or closed, by "YYYY-MM-DD"; until tapped,
     Today is open and every other day closed. */
  const [dayOpen, setDayOpen] = useState({});
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
    setDayOpen({});
    if (kind === "all") { setLog(null); return; }
    let live = true;
    setLog(undefined); setErr("");
    S.fetchActivity(kpiId, kind).then((r) => { if (!live) return; if (r.status) setLog(r); else { setErr(r.message); setLog(null); } }).catch((e) => { if (live) { setErr(e.message); setLog(null); } });
    return () => { live = false; };
  }, [kpiId, kind, tries]);
  const src = kind === "all" ? d : log || { activity_log: [], activity_total: 0, activity_limit: 0 };
  const rows = src.activity_log || [];
  const shown = all ? rows : rows.slice(0, SHOWN);
  /* The rows come newest first, so the days do too. */
  const days = [];
  for (const a of shown) {
    const key = String(a.at || "").slice(0, 10);
    if (!days.length || days[days.length - 1].key !== key) days.push({ key, rows: [] });
    days[days.length - 1].rows.push(a);
  }
  const isOpen = (key) => (key in dayOpen ? dayOpen[key] : histDay(key) === "Today");
  const est = d.estimate_history || [];
  return (
    <div className="sec" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Tabs items={KINDS} value={kind} onChange={setKind} />
      {log === undefined && <span className="mini" style={{ padding: "8px 0" }}>Loading…</span>}
      {err && <span style={{ display: "flex", alignItems: "center", gap: 8 }}><Err>{err}</Err><Button size="sm" kind="ghost" onClick={() => setTries((n) => n + 1)}>Retry</Button></span>}
      {days.map((g) => {
        const open = isOpen(g.key);
        return (
          <div key={g.key || "none"}>
            <DayRow label={histDay(g.key)} count={g.rows.length} open={open} onToggle={() => setDayOpen((o) => ({ ...o, [g.key]: !open }))} />
            {open && g.rows.map((a) => {
              const txt = describe(a);
              return (
                <div key={a.id} className="notif" style={{ padding: "8px 0" }}>
                  <span className="icbox" style={{ background: a.success === false ? "var(--over-bg)" : "var(--hover)", color: a.success === false ? "var(--over)" : "var(--subtle)", width: 28, height: 28 }}><Icon n={a.success === false ? "warn" : eventIcon(a.event)} size={14} /></span>
                  <div style={{ minWidth: 0 }}><p style={{ overflowWrap: "anywhere" }}>{a.label}{txt ? <span style={{ color: "var(--subtle)" }}> — {txt}</span> : null}</p><small>{a.at}{a.actor ? ` · ${a.actor}` : ""}</small></div>
                </div>
              );
            })}
          </div>
        );
      })}
      {log !== undefined && !rows.length && !err && <span className="mini" style={{ padding: "8px 0" }}>{kind === "all" ? "Nothing logged yet." : "Nothing of this kind logged yet."}</span>}
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
          <Field label="Name" required><Input value={name} autoFocus onChange={(e) => setName(e.target.value)} /></Field>
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

/* What the client attached when raising the task (progress rows marked
   from_client). Read-only, kept apart from the team's own updates, and never
   the progress summary Complete asks for. Nothing when there is none. */
export function ClientProgress({ progress }) {
  const rows = (progress || []).filter((p) => p.from_client);
  if (!rows.length) return null;
  return (
    <div className="callout" style={{ flexDirection: "column", alignItems: "stretch", gap: 6, background: "var(--lz-paused-bg)", borderColor: "var(--pri-important)" }}>
      <h3 style={{ margin: 0 }}>📎 From the client ({rows.length})</h3>
      {rows.map((p) => <ProgressItem key={`c${p.id}`} p={{ ...p, can_edit: false }} />)}
    </div>
  );
}

/* 💬 Chat with the client (models/kpi_chat.py), WhatsApp style: the client on
   the left in white, the team on the right in green, a day divider, and a box
   at the bottom. Enter sends, Shift+Enter is a new line. The client group only
   ever sees "Reply from our team"; here staff see who wrote what. Refreshes
   every 10 s while open. */
const CHAT_DAY = (d) => {
  const today = new Date().toDateString();
  const yday = new Date(Date.now() - 86400000).toDateString();
  const k = d.toDateString();
  return k === today ? "Today" : k === yday ? "Yesterday" : d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
};
const chatDate = (at) => (at ? new Date(String(at).replace(" ", "T") + "Z") : null);

/* "Everything on this task": one list, newest first, by day, with the same
   filters as Odoo's KPI Details › History. Activity (pauses, renames …) is its
   own filter so it doesn't bury the conversation. */
const TL_FILTERS = [
  ["all", "All", null],
  ["talks", "Questions", ["question"]],
  ["progress", "Progress", ["progress"]],
  ["meetings", "Meetings", ["meeting"]],
  ["code", "Code", ["code"]],
  ["documents", "Documents", ["document"]],
  ["activity", "Activity", ["activity"]],
];
const TL_ICON = { talk: "chat", question: "info", progress: "pen", meeting: "cal", code: "link", document: "paperclip", activity: "clock" };
/* One talk with the client (a back-and-forth), as on Client Talks ›
   Discussions: one row, closed until tapped; open, the bubbles. */
function TalkRow({ it }) {
  const [open, setOpen] = useState(false);
  const waiting = (it.badge || "").startsWith("●");
  return (
    <div className="tl-talk">
      <button type="button" className="tl-talk-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="tl-ic" aria-hidden="true"><Icon n="chat" size={15} /></span>
        <b>{it.title}</b>
        <span className="mini">{it.count} message{it.count === 1 ? "" : "s"}</span>
        {it.badge && <span className={`tl-talk-st${waiting ? " wait" : ""}`}>{it.badge}</span>}
      </button>
      {open && (
        <div className="tl-msgs">
          {(it.messages || []).map((m) => (
            <div key={m.id} className={`tl-msg ${m.side === "team" ? "team" : "client"}`}>
              <div className="tl-msg-top"><b>{m.who}{m.side === "client" ? " · client" : ""}</b><span>{m.time}</span></div>
              {m.body && <p>{m.body}</p>}
              {(m.files || []).map((f) => f.kind === "image"
                ? <a key={f.id} href={href(f.url)} target="_blank" rel="noreferrer" title={f.name}><img src={href(f.url)} alt={f.name} loading="lazy" /></a>
                : f.kind === "video" ? <video key={f.id} controls preload="metadata" src={href(f.url)} />
                  : f.kind === "audio" ? <audio key={f.id} controls preload="metadata" src={href(f.url)} />
                    : <a key={f.id} className="chat-doc" href={href(f.url)} target="_blank" rel="noreferrer">📄 <b>{f.name}</b></a>)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TaskTimeline({ kpiId }) {
  const [items, setItems] = useState(null);
  const [filter, setFilter] = useState("all");
  const [shown, setShown] = useState(30);
  const [tries, setTries] = useState(0);
  /* Day rows the person opened or closed, by label; until tapped, Today is
     open and every other day closed. */
  const [openDays, setOpenDays] = useState({});
  useEffect(() => {
    let live = true;
    setItems(null);
    setOpenDays({});
    S.fetchHistory(kpiId).then((r) => { if (live) setItems(r.status ? r.items || [] : []); }).catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, [kpiId, tries]);
  const dayIsOpen = (label) => (label in openDays ? openDays[label] : label === "Today");
  const all = items || [];
  const kindsOf = (f) => TL_FILTERS.find(([k]) => k === f)?.[2];
  const pick = (f) => { const ks = kindsOf(f); return all.filter((i) => (ks ? ks.includes(i.kind) : i.kind !== "activity")); };
  const list = pick(filter);
  const days = [];
  for (const it of list.slice(0, shown)) {
    const d = chatDate(it.at);
    const label = !d ? "" : d.toDateString() === new Date().toDateString() ? "Today"
      : d.toDateString() === new Date(Date.now() - 864e5).toDateString() ? "Yesterday"
        : d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
    if (!days.length || days[days.length - 1].label !== label) days.push({ label, items: [] });
    days[days.length - 1].items.push(it);
  }
  return (
    <div className="sec tl">
      <div className="tl-head">
        <h3>Everything on this task</h3>
        <IconButton icon="refresh" label="Refresh" size={14} onClick={() => setTries((n) => n + 1)} />
      </div>
      <div className="pillset">
        {TL_FILTERS.map(([k, l]) => (
          <button key={k} type="button" className={`pill${filter === k ? " on" : ""}`} aria-pressed={filter === k}
            onClick={() => { setFilter(k); setShown(30); setOpenDays({}); }}>{l} <span className="mini">{pick(k).length}</span></button>
        ))}
      </div>
      {items === null ? <p className="mini">Loading…</p> : !days.length ? <p className="mini">Nothing here yet.</p> : days.map((day) => (
        <div key={day.label}>
          <DayRow label={day.label} count={day.items.length} open={dayIsOpen(day.label)} onToggle={() => setOpenDays((o) => ({ ...o, [day.label]: !dayIsOpen(day.label) }))} />
          {dayIsOpen(day.label) && day.items.map((it) => it.kind === "talk" ? <TalkRow key={it.key} it={it} /> : (
            <div key={it.key} className={`tl-row k-${it.kind}`}>
              <span className="tl-ic" aria-hidden="true"><Icon n={TL_ICON[it.kind] || "clock"} size={15} /></span>
              <div style={{ minWidth: 0 }}>
                <div className="tl-top">
                  <b>{it.title}</b>
                  <span className="mini">{it.who ? `${it.who} · ` : ""}{chatDate(it.at)?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  {it.badge && <span className={`chip-sm${it.badge === "waiting for reply" ? " tl-wait" : ""}`}>{it.badge}</span>}
                </div>
                {it.body && <p className={it.kind === "talk" ? "tl-bubble" : "tl-body"}>{it.body}</p>}
              </div>
            </div>
          ))}
        </div>
      ))}
      {list.length > shown && <Button size="sm" kind="ghost" onClick={() => setShown((n) => n + 30)}>Load older</Button>}
    </div>
  );
}

/* What a message's files come to, for the reply banner and a quote with no
   text: "📷 1 photo", "🎥 2 videos · 🎵 1 audio". */
const chatFilesLabel = (files) => {
  const n = { image: 0, video: 0, audio: 0, document: 0 };
  for (const f of files || []) if (n[f.kind] !== undefined) n[f.kind] += 1;
  return [n.image && `📷 ${n.image} photo${n.image > 1 ? "s" : ""}`, n.video && `🎥 ${n.video} video${n.video > 1 ? "s" : ""}`, n.audio && `🎵 ${n.audio} audio`,
    n.document && `📄 ${n.document} document${n.document > 1 ? "s" : ""}`]
    .filter(Boolean).join(" · ") || ((files || []).length ? "📎 file" : "");
};
const chatWho = (m) => (m.side === "team" ? m.who : `${m.who} · client`);
const CHAT_KINDS = /^(image|video|audio)\//;
/* 📄 Documents, as in WhatsApp's 📎 Document (same list as the server). */
const CHAT_DOCS = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|zip|rar|7z)$/i;
const chatFileOk = (f) => CHAT_KINDS.test(f.type || "") || CHAT_DOCS.test(f.name || "");
/* The pin menu: what each choice lets the file picker show. */
const CHAT_PICK = [
  ["camera", "📷 Camera", "image/*,video/*"],
  ["media", "🖼 Photos & videos", "image/*,video/*"],
  ["audio", "🎵 Audio", "audio/*"],
  ["doc", "📄 Document", ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.rtf,.txt,.csv,.zip,.rar,.7z"],
];

/* One picture, video or voice note in a bubble; its name and size under it.
   f.url is an Odoo path, served through the proxy with the session. A photo
   opens full screen in the page (onView), not in a new tab. */
function ChatMedia({ f, onView, msg }) {
  const url = href(f.url);
  /* msg: the message it came in, for "who · when" and its words in the viewer. */
  const view = () => onView?.({ url, name: f.name || "photo", who: msg ? chatWho(msg) : "", at: msg?.at, body: msg?.body || "" });
  return (
    <div className="chat-media">
      {f.kind === "image" ? <img src={url} alt={f.name || "photo"} loading="lazy" role="button" tabIndex={0} title="Open photo"
        onClick={view} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); view(); } }} />
        : f.kind === "video" ? <video controls preload="metadata" src={url} />
          : f.kind === "audio" ? <audio controls preload="metadata" src={url} />
            : <a href={url} target="_blank" rel="noreferrer" className="chat-doc">{f.kind === "document" ? "📄" : "📎"} <b>{f.name || "file"}</b></a>}
      <div className="chat-fname">{f.name}{f.size ? ` · ${fmtBytes(f.size)}` : ""}</div>
    </div>
  );
}

/* The tick on our own bubbles, as in WhatsApp: ✓ saved · ✓✓ reached the
   client's group · blue ✓✓ the client opened the chat · ⚠ WhatsApp refused
   it (click to retry). */
function ChatTick({ m, onRetry }) {
  const failed = m.status === "failed";
  const title = failed ? `${m.error || "Not delivered."} Click to retry.`
    : m.status === "seen" ? "Seen by the client" : m.status === "sent" ? "Delivered to the client's WhatsApp group" : "Sending…";
  return (
    <span title={title} onClick={failed ? onRetry : undefined} role={failed ? "button" : undefined}
      style={{ marginLeft: 4, letterSpacing: -2, cursor: failed ? "pointer" : "default", color: m.status === "seen" ? "#53bdeb" : failed ? "var(--danger, #c23b3b)" : "inherit" }}>
      {failed ? "⚠" : m.status === "pending" ? "✓" : "✓✓"}
    </span>
  );
}

/* The reactions on the long-press card: six quick ones, "+" opens the grid. */
const CHAT_QUICK = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const CHAT_EMOJIS = ["👍", "👎", "❤️", "🔥", "🎉", "👏", "🙏", "💯", "😂", "🤣", "😅", "😊", "😍", "😎", "🤔", "😐", "😮", "😢", "😭", "😡", "🥳", "🤝", "💪", "✅", "❌", "⚠️", "👀", "🚀", "⭐", "💡", "⏰", "📌"];
const CHAT_DELETED = "This message was deleted";
/* Clipboard first; the hidden-textarea copy for browsers / http pages without it. */
const chatCopy = async (s) => {
  try { await navigator.clipboard.writeText(s); return true; } catch (e) { /* fall back below */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = s; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
};

/* WhatsApp's own icons (material paths), drawn in the text colour. */
const CHAT_SVG = {
  reply: "M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z",
  smiley: "M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z",
  down: "M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z",
  clip: "M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z",
  send: "M2.01 21L23 12 2.01 3 2 10l15 2-15 2z",
  mic: "M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z",
};
/* Voice notes: the first format this browser records, the 15 minute cap and
   the mm:ss on the recording bar. */
const VOICE_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
const VOICE_MAX_MS = 15 * 60 * 1000;
const VOICE_NA = "Microphone not available";
const voiceClock = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const voiceName = (type) => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const ext = /ogg/.test(type) ? "ogg" : /mp4|m4a|aac/.test(type) ? "m4a" : "webm";
  return `voice-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
};
const ChatSvg = ({ d, size = 24 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false"><path fill="currentColor" d={CHAT_SVG[d]} /></svg>
);
/* The composer's emoji panel: common ones, inserted at the cursor. */
const CHAT_PANEL = ["😀", "😁", "😂", "😊", "😍", "😘", "🤔", "😅", "😉", "🙂", "😎", "😢", "😭", "😡", "👍", "👎", "🙏", "👏", "💪", "🤝",
  "👌", "✌️", "🙌", "❤️", "🔥", "🎉", "✅", "❌", "⚠️", "⭐", "💯", "👀", "🚀", "💡", "📌", "⏰", "📷", "📎", "📝", "💬"];

/* Long-press (held 450 ms, under 8 px of movement; touch or mouse) or a
   right-click opens a bubble's action card, as in WhatsApp. Returns the props
   for one bubble; the click that follows a long-press is swallowed so the
   quote / media under the finger isn't opened too. */
function useLongPress(onOpen, delay = 450) {
  const timer = useRef(null);
  const start = useRef(null);
  const fired = useRef(false);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => clear, []);
  return (m) => ({
    onPointerDown: (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      clear();
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => { timer.current = null; fired.current = true; onOpen(m); }, delay);
    },
    onPointerMove: (e) => {
      if (!timer.current || !start.current) return;
      if (Math.abs(e.clientX - start.current.x) > 8 || Math.abs(e.clientY - start.current.y) > 8) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu: (e) => { e.preventDefault(); clear(); fired.current = true; onOpen(m); },
    onClickCapture: (e) => { if (fired.current) { fired.current = false; e.preventDefault(); e.stopPropagation(); } },
  });
}

/* The action card over a dimmed scrim: the quick reactions (or the full grid
   after "+"), then Reply / Edit / Info / Copy / Delete, each only when allowed.
   Click the scrim or press Esc to close. */
function ChatActionCard({ m, canReact, actions, onPick, onClose }) {
  const [grid, setGrid] = useState(false);
  const opened = useRef(Date.now());
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const mine = (m.reactions || []).find((r) => r.mine)?.emoji;
  /* The pointer-up that ends the long-press lands on the scrim: not a close. */
  const scrimClick = (e) => { if (e.target === e.currentTarget && Date.now() - opened.current > 400) onClose(); };
  const emoji = (e) => (
    <button key={e} type="button" className={e === mine ? "on" : ""} title={e === mine ? "Remove reaction" : "React"} onClick={() => onPick("react", e)}>{e}</button>
  );
  return (
    <div className="chat-scrim" role="presentation" onClick={scrimClick}>
      <div className="chat-card" role="dialog" aria-modal="true" aria-label="Message actions">
        {canReact && (grid ? (
          <div className="chat-emoji-grid">
            <button type="button" className="chat-emoji-back" aria-label="Back" title="Back" onClick={() => setGrid(false)}>←</button>
            {CHAT_EMOJIS.map(emoji)}
          </div>
        ) : (
          <div className="chat-react-strip">
            {CHAT_QUICK.map(emoji)}
            <button type="button" className="chat-react-more" aria-label="More reactions" title="More reactions" onClick={() => setGrid(true)}>+</button>
          </div>
        ))}
        {!grid && (
          <div className="chat-card-list">
            {actions.map((a) => (
              <button key={a.key} type="button" className={a.danger ? "danger" : ""} onClick={() => onPick(a.key)}><span aria-hidden="true">{a.icon}</span>{a.label}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* Message info: three plain lines, Sent / Delivered / Seen, each with its
   local time ("07:35 pm"), the date in front when it was not today
   ("22 Oct, 07:35 pm"), or "not yet". */
const CHAT_EVENTS = [
  ["at", "✓", "Sent", ""],
  ["delivered_at", "✓✓", "Delivered to the client's group", ""],
  ["seen_at", "✓✓", "Seen by the client", "#2E90FA"],
];
const chatInfoTime = (d) => {
  const t = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true }).toLowerCase();
  if (d.toDateString() === new Date().toDateString()) return t;
  const now = new Date();
  const day = d.toLocaleDateString("en-GB", d.getFullYear() === now.getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
  return `${day}, ${t}`;
};
function ChatInfoLog({ m }) {
  return (
    <div className="chat-log">
      {CHAT_EVENTS.map(([k, tick, label, color]) => {
        const d = chatDate(k === "at" ? m.at : m.info?.[k]);
        const ok = d && !Number.isNaN(d.getTime());
        return (
          <div key={k} className="chat-log-row">
            <span className="chat-log-tick" style={color ? { color } : undefined}>{tick}</span>
            <span className="chat-log-label">{label}</span>
            <span className="chat-log-time">{ok ? chatInfoTime(d) : "not yet"}</span>
          </div>
        );
      })}
    </div>
  );
}

/* A chat photo full screen inside the page: dark backdrop, the file name, an
   open / download link and ✕. A click outside the picture or Esc closes it. */
function ChatPhotoViewer({ photo, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const out = (e) => { if (e.target === e.currentTarget) onClose(); };
  /* As in WhatsApp: who sent it and when on top, its words under the photo. */
  const d = chatDate(photo.at);
  const when = d ? `${d.toDateString() === new Date().toDateString() ? "Today" : d.toLocaleDateString([], { day: "numeric", month: "short" })} at ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
  return (
    <div className="chat-viewer" role="dialog" aria-modal="true" aria-label={photo.name} onClick={out}>
      <div className="chat-viewer-bar">
        <span className="chat-viewer-name"><b>{photo.who || photo.name}</b>{when && <small>{when}</small>}</span>
        <a href={photo.url} target="_blank" rel="noreferrer" download={photo.name} title="Open / download" aria-label="Open / download">⤓</a>
        <button type="button" title="Close" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="chat-viewer-stage" onClick={out}>
        <img src={photo.url} alt={photo.name} />
      </div>
      {photo.body && <div className="chat-viewer-cap">{photo.body}</div>}
    </div>
  );
}

/* A new client message while this browser tab is in the background or the
   window is not focused: a soft two-note "pop" (Web Audio, no files) and
   "(N) New message · <task>" in the tab title until the person comes back.
   Browsers block sound before a gesture, so the audio is opened on the
   first click, key or touch anywhere on the page. */
let chatAudio = null;
function chatAudioWake() {
  try {
    if (!chatAudio) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      chatAudio = new Ctx();
    }
    if (chatAudio.state === "suspended") chatAudio.resume().catch(() => {});
  } catch { /* no sound then */ }
}
function chatPop() {
  const ctx = chatAudio;
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const t0 = ctx.currentTime;
    [[880, 0], [1320, 0.08]].forEach(([hz, at]) => {
      const t = t0 + at;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.12);
    });
  } catch { /* no sound then */ }
}
const chatAway = () => document.hidden || !document.hasFocus();
function useChatAlert(kpiId, messages, label) {
  /* lastClient: newest client message id already shown; null until the
     chat's first load, which only sets it (no alert for old messages). */
  const lastClient = useRef(null);
  const unseen = useRef(0);
  const savedTitle = useRef(null);
  const restore = () => {
    if (savedTitle.current !== null) document.title = savedTitle.current;
    savedTitle.current = null;
    unseen.current = 0;
  };
  useEffect(() => { lastClient.current = null; }, [kpiId]);
  useEffect(() => {
    const evs = ["pointerdown", "keydown", "touchstart"];
    evs.forEach((e) => document.addEventListener(e, chatAudioWake, { passive: true }));
    const back = () => { if (!chatAway()) restore(); };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      evs.forEach((e) => document.removeEventListener(e, chatAudioWake, { passive: true }));
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
      restore();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!messages) return;
    const ids = messages.filter((m) => m.side === "client").map((m) => Number(m.id)).filter(Number.isFinite);
    const top = ids.length ? Math.max(...ids) : 0;
    if (lastClient.current === null) { lastClient.current = top; return; }
    const fresh = ids.filter((id) => id > lastClient.current).length;
    if (top > lastClient.current) lastClient.current = top;
    if (!fresh || !chatAway()) return;
    chatPop();
    if (savedTitle.current === null) savedTitle.current = document.title;
    unseen.current += fresh;
    document.title = `(${unseen.current}) New message · ${label || "Chat"}`;
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function ChatTab({ kpiId, onSeen, taskRef }) {
  const flags = useFlags();
  const [res, setRes] = useState(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  /* A send in flight: the 3 s poll stands aside so its answer cannot wipe the
     provisional bubble before the send's own answer lands. */
  const sendingRef = useRef(false);
  /* Picked files as {file, url}: url is an object URL for an image's thumbnail. */
  const [picked, setPicked] = useState([]);
  const [pickErr, setPickErr] = useState("");
  const [menu, setMenu] = useState(false);
  const [reply, setReply] = useState(null);
  /* card: the message whose long-press card is open. info: the message whose
     Sent / Delivered / Seen panel is open. editing: {m, draft} — the message
     being edited and the box's text from before, put back on cancel. */
  const [card, setCard] = useState(null);
  const [info, setInfo] = useState(null);
  const [editing, setEditing] = useState(null);
  /* photo: {url, name} of the picture open full screen. */
  const [photo, setPhoto] = useState(null);
  const dlg = useDialogs();
  const up = useUpload();
  const body = useRef(null);
  const count = useRef(0);
  const inputs = useRef({});
  const menuRef = useRef(null);
  /* emo: the composer's emoji panel is open. */
  const [emo, setEmo] = useState(false);
  const emoRef = useRef(null);
  const inputRef = useRef(null);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  /* markSeen: the tab is on screen, so the client's messages count as seen
     (blue ✓✓ on their page). active: also touched in the last minute. */
  const touchRef = useRef(Date.now());
  useEffect(() => {
    const touch = () => { touchRef.current = Date.now(); };
    const evs = ["pointerdown", "keydown", "touchstart", "wheel", "mousemove"];
    evs.forEach((n) => document.addEventListener(n, touch, { passive: true, capture: true }));
    return () => evs.forEach((n) => document.removeEventListener(n, touch, { capture: true }));
  }, []);
  const load = () => {
    if (sendingRef.current) return Promise.resolve();
    const visible = document.visibilityState === "visible";
    const active = visible && Date.now() - touchRef.current < 60000;
    return S.fetchChat(kpiId, { markSeen: visible, active }).then((r) => {
      if (sendingRef.current) return;
      if (r.status === false) { setRes({ messages: [], error: r.message }); return; }
      setRes(r);
    }).catch((e) => setRes({ messages: [], error: e.message }));
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [kpiId]); // eslint-disable-line react-hooks/exhaustive-deps
  const retry = async (m) => {
    const r = await S.retryChat(kpiId, m.id);
    if (r.status === false) flags.err(r.message); else setRes(r);
  };
  /* Thumbnails still held when the tab closes are let go. */
  useEffect(() => () => pickedRef.current.forEach((p) => p.url && URL.revokeObjectURL(p.url)), []);
  /* The pin menu closes on a click anywhere else. */
  useEffect(() => {
    if (!menu) return undefined;
    const off = (e) => { if (!menuRef.current?.contains(e.target)) setMenu(false); };
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [menu]);
  /* The emoji panel closes on a click anywhere else or Esc. */
  useEffect(() => {
    if (!emo) return undefined;
    const off = (e) => { if (!emoRef.current?.contains(e.target)) setEmo(false); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setEmo(false); } };
    document.addEventListener("mousedown", off);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("keydown", onKey, true); };
  }, [emo]);
  /* An emoji from the panel goes in at the cursor; the box keeps focus. */
  const insertEmoji = (em) => {
    const el = inputRef.current;
    const a = el ? el.selectionStart ?? text.length : text.length;
    const b = el ? el.selectionEnd ?? a : a;
    setText((t) => t.slice(0, a) + em + t.slice(b));
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(a + em.length, a + em.length); } });
  };
  /* Scroll to the newest only when a message arrives, not on every refresh. */
  useEffect(() => {
    const n = res?.messages?.length || 0;
    if (n !== count.current && body.current) body.current.scrollTop = body.current.scrollHeight;
    count.current = n;
  }, [res]);
  useChatAlert(kpiId, res && !res.error ? res.messages : null, taskRef);
  /* Checked before anything is uploaded: photos, videos, audio and documents,
     up to 10 files, 50 MB each. A bad pick adds nothing and says why. */
  const addFiles = (list) => {
    const bad = list.find((f) => !chatFileOk(f));
    if (bad) { setPickErr(`“${bad.name}” can't be sent in the chat: photos, videos, audio and documents (PDF, Word, Excel …) only.`); return; }
    const big = list.find((f) => f.size > S.CHAT_MAX_BYTES);
    if (big) { setPickErr(`“${big.name}” is ${fmtBytes(big.size)}. Each file can be at most 50 MB.`); return; }
    if (picked.length + list.length > S.CHAT_MAX_FILES) { setPickErr(`At most ${S.CHAT_MAX_FILES} files in one message.`); return; }
    setPickErr("");
    setPicked((all) => [...all, ...list.map((file) => ({ file, url: file.type.startsWith("image/") ? URL.createObjectURL(file) : "" }))]);
  };
  const dropFile = (i) => {
    const gone = picked[i];
    if (gone?.url) URL.revokeObjectURL(gone.url);
    setPicked((all) => all.filter((_, j) => j !== i));
    setPickErr("");
  };
  const choose = (k) => { setMenu(false); inputs.current[k]?.click(); };
  /* Tap a quote: the original bubble scrolls into view and flashes. */
  const jumpTo = (id) => {
    const el = document.getElementById(`chat-msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("chat-flash");
    void el.offsetWidth;
    el.classList.add("chat-flash");
    setTimeout(() => el.classList.remove("chat-flash"), 1600);
  };
  /* Long-press card actions. The server answers every one with the whole
     chat, like fetchChat. */
  const canAct = !!(res && !res.error && res.can_act);
  const act = async (m, action, extra) => {
    const r = await S.chatAct(kpiId, m.id, action, extra);
    if (r.status === false) { flags.err(r.message); return false; }
    setRes(r);
    return true;
  };
  const openCard = (m) => { if (!m.deleted && !String(m.id).startsWith("tmp")) setCard(m); };
  const press = useLongPress(openCard);
  const cancelEdit = () => { if (editing) { setText(editing.draft); setEditing(null); } };
  const canSend = !!(res && !res.error && res.can_send && !res.locked);
  /* The hover ↩ beside a bubble: the same as the card's Reply. */
  const quickReply = (m) => { cancelEdit(); setReply(m); requestAnimationFrame(() => inputRef.current?.focus()); };
  const cardActions = (m) => {
    return [
      canAct && canSend && { key: "reply", icon: "↩", label: "Reply" },
      canAct && m.can_edit && { key: "edit", icon: "✎", label: "Edit" },
      m.info && { key: "info", icon: "ⓘ", label: "Info" },
      m.body && { key: "copy", icon: "⧉", label: "Copy" },
      canAct && m.can_delete && { key: "delete", icon: "🗑", label: "Delete", danger: true },
    ].filter(Boolean);
  };
  const pick = async (action, emoji) => {
    const m = card;
    setCard(null);
    if (!m) return;
    if (action === "react") { await act(m, "react", { emoji }); return; }
    if (action === "reply") { cancelEdit(); setReply(m); return; }
    if (action === "edit") { setReply(null); setEditing({ m, draft: editing ? editing.draft : text }); setText(m.body || ""); return; }
    if (action === "info") { setInfo(m); return; }
    if (action === "copy") { if (await chatCopy(m.body || "")) flags.ok("Copied."); else flags.err("Could not copy."); return; }
    if (action === "delete") {
      if (!(await dlg.confirm({ title: "Delete this message for everyone?", confirmLabel: "Delete", danger: true }))) return;
      await act(m, "delete");
    }
  };
  const send = async () => {
    const t = text.trim();
    if ((!t && !picked.length) || busy) return;
    /* Editing: the box holds the new text for the message in the bar. */
    if (editing) {
      if (!t) return;
      setBusy(true);
      try { if (await act(editing.m, "edit", { text: t })) { setText(editing.draft); setEditing(null); } }
      finally { setBusy(false); }
      return;
    }
    setBusy(true);
    sendingRef.current = true;
    /* A text message shows at once with a single ✓ and the box clears; the
       server's answer replaces it. Files keep the progress bar. */
    let temp = null;
    if (!picked.length) {
      temp = {
        id: `tmp${Date.now()}`, side: "team", who: "You", body: t, files: [], status: "pending", error: "",
        at: new Date().toISOString().slice(0, 19).replace("T", " "),
        reply: reply ? { id: reply.id, side: reply.side, who: reply.who, text: reply.body || chatFilesLabel(reply.files) } : false,
      };
      setRes((r) => ({ ...(r || {}), messages: [...(r?.messages || []), temp] }));
      setText(""); setReply(null);
    }
    const unsend = () => {
      if (!temp) return;
      setRes((r) => ({ ...(r || {}), messages: (r?.messages || []).filter((m) => m.id !== temp.id) }));
      setText(t); setReply(reply);
    };
    try {
      const r = picked.length
        ? await S.sendChatFiles(kpiId, { text: t, replyTo: reply?.id, files: picked.map((p) => p.file) }, up.start(true))
        : await S.sendChat(kpiId, t, reply?.id);
      if (r.status === false) { unsend(); flags.err(r.message); return; }
      picked.forEach((p) => p.url && URL.revokeObjectURL(p.url));
      setPicked([]); setPickErr(""); setReply(null);
      setText("");
      setRes(r);
      onSeen?.();   /* the tab's waiting count drops once the team has replied */
    } catch (e) {
      unsend();
      if (e.message === UPLOAD_CANCELLED) flags.warn(UPLOAD_CANCELLED); else flags.err(e.message);
    } finally { up.finish(); setBusy(false); sendingRef.current = false; }
  };
  /* 🎙 Voice note, WhatsApp style: the mic records (MediaRecorder, a chunk
     every 250 ms); ⏸ pauses the same recording, ▶ plays what is there so far,
     🎙 goes on recording, 🗑 throws it away. Nothing leaves until ➤, which
     sends it as one audio file through the normal upload. rec (shown):
     {paused, ms, url}; recRef (working): {mr, stream, chunks, mime, ms, since,
     timer, url} where since is when the running stretch began (0 = paused). */
  const [rec, setRec] = useState(null);
  const recRef = useRef(null);
  const aliveRef = useRef(true);
  const recMs = (r) => r.ms + (r.since ? Date.now() - r.since : 0);
  const recClose = (r) => {
    if (!r) return;
    clearInterval(r.timer);
    try { if (r.mr.state !== "inactive") r.mr.stop(); } catch (e) { /* already stopped */ }
    try { r.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* no tracks */ }
    if (r.url) URL.revokeObjectURL(r.url);
  };
  const recClear = () => { const r = recRef.current; recRef.current = null; recClose(r); setRec(null); };
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; const r = recRef.current; recRef.current = null; recClose(r); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const pauseRec = () => {
    const r = recRef.current;
    if (!r || !r.since) return;
    try { r.mr.pause(); } catch (e) { /* not recording */ }
    try { r.mr.requestData(); } catch (e) { /* the last chunk comes with the next one */ }
    r.ms = Math.min(recMs(r), VOICE_MAX_MS); r.since = 0;
    setRec({ paused: true, ms: r.ms, url: "" });
  };
  const resumeRec = () => {
    const r = recRef.current;
    if (!r || r.since || r.ms >= VOICE_MAX_MS) return;
    if (r.url) { URL.revokeObjectURL(r.url); r.url = ""; }
    try { r.mr.resume(); } catch (e) { return; }
    r.since = Date.now();
    setRec({ paused: false, ms: r.ms, url: "" });
  };
  const playRec = () => {
    const r = recRef.current;
    if (!r || r.since || !r.chunks.length) return;
    if (r.url) URL.revokeObjectURL(r.url);
    r.url = URL.createObjectURL(new Blob(r.chunks, { type: r.mime.split(";")[0] }));
    setRec((x) => (x ? { ...x, url: r.url } : x));
  };
  const startRec = async () => {
    if (busy || recRef.current) return;
    const MR = typeof window !== "undefined" ? window.MediaRecorder : undefined;
    /* Browsers offer the microphone only on a secure address (https or
       localhost); on http://<ip>:3100 there is no permission prompt at all. */
    if (typeof window !== "undefined" && !window.isSecureContext) {
      setPickErr("🔒 The browser allows the microphone only on a secure address. Open the app over https (or on this computer as localhost) to record voice notes.");
      return;
    }
    if (!MR || !navigator.mediaDevices?.getUserMedia) { setPickErr(VOICE_NA); return; }
    let stream;
    /* This call is what makes the browser ask "Allow microphone?". */
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) {
      const why = e && e.name;
      setPickErr(why === "NotAllowedError" || why === "SecurityError"
        ? "🎤 The microphone is blocked for this site. Click the 🔒 / 🎤 icon in the address bar, choose Allow, then tap the mic again."
        : why === "NotFoundError" ? "No microphone found on this device." : VOICE_NA);
      return;
    }
    if (!aliveRef.current || recRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
    const mime = VOICE_TYPES.find((t) => { try { return MR.isTypeSupported(t); } catch (e) { return false; } }) || "";
    let mr;
    try { mr = new MR(stream, mime ? { mimeType: mime } : undefined); } catch (e) { stream.getTracks().forEach((t) => t.stop()); setPickErr(VOICE_NA); return; }
    const r = { mr, stream, chunks: [], mime: mr.mimeType || mime || "audio/webm", ms: 0, since: 0, timer: 0, url: "" };
    mr.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
    try { mr.start(250); } catch (e) { recClose(r); setPickErr(VOICE_NA); return; }
    r.since = Date.now();
    recRef.current = r;
    /* At 15 minutes it pauses by itself; ➤ or 🗑 from there. */
    r.timer = setInterval(() => {
      if (recRef.current !== r || !r.since) return;
      const ms = recMs(r);
      if (ms >= VOICE_MAX_MS) { pauseRec(); return; }
      setRec((x) => (x ? { ...x, ms } : x));
    }, 250);
    setPickErr(""); setMenu(false); setEmo(false);
    setRec({ paused: false, ms: 0, url: "" });
  };
  const sendRec = async () => {
    const r = recRef.current;
    if (!r || busy) return;
    clearInterval(r.timer);
    /* stop() hands over the last chunk, then fires onstop. */
    if (r.mr.state !== "inactive") {
      const stopped = new Promise((ok) => { r.mr.onstop = ok; });
      try { r.mr.stop(); } catch (e) { /* already stopped */ }
      await Promise.race([stopped, new Promise((ok) => setTimeout(ok, 3000))]);
    }
    const type = r.mime.split(";")[0] || "audio/webm";
    const file = new File(r.chunks, voiceName(type), { type });
    recClear();
    if (!file.size) { flags.err("Nothing was recorded."); return; }
    setBusy(true);
    sendingRef.current = true;
    try {
      const out = await S.sendChatFiles(kpiId, { text: "", replyTo: reply?.id, files: [file] }, up.start(true));
      if (out.status === false) { flags.err(out.message); return; }
      setReply(null);
      setRes(out);
      onSeen?.();
    } catch (e) {
      if (e.message === UPLOAD_CANCELLED) flags.warn(UPLOAD_CANCELLED); else flags.err(e.message);
    } finally { up.finish(); setBusy(false); sendingRef.current = false; }
  };
  const groups = [];
  for (const m of res?.messages || []) {
    const d = chatDate(m.at);
    const day = d ? CHAT_DAY(d) : "";
    if (!groups.length || groups[groups.length - 1].day !== day) groups.push({ day, msgs: [] });
    groups[groups.length - 1].msgs.push(m);
  }
  return (
    <div className="sec chat">
      <div className="chat-head">💬 Chat with {res?.client || "the client"}<span className="mini"> · the client sees team messages as “Reply from our team”</span></div>
      <div className="chat-body" ref={body}>
        {!res && <span className="mini">Loading…</span>}
        {res?.error && <div className="callout">{res.error}</div>}
        {res && !res.error && !groups.length && <div className="chat-note">No messages yet. When the client sends 💬 Discuss from their WhatsApp group, it shows here.</div>}
        {groups.map((g) => (
          <div key={g.day}>
            <div className="chat-day"><span>{g.day}</span></div>
            {g.msgs.map((m, i) => {
              const reacts = m.deleted ? [] : (m.reactions || []);
              const live = !m.deleted && !String(m.id).startsWith("tmp");
              /* The tail: only on the first bubble of a run from one side. */
              const tail = !i || g.msgs[i - 1].side !== m.side;
              return (
                <div key={m.id} className={`chat-row ${m.side === "team" ? "out" : "in"}${tail ? " tail" : ""}${reacts.length ? " has-react" : ""}`}>
                  <div className={`chat-bubble${m.deleted ? " deleted" : ""}`} id={`chat-msg-${m.id}`} {...press(m)}>
                    {live && (
                      <button type="button" className="chat-arrow" aria-label="Message menu" title="Menu"
                        onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); openCard(m); }}><ChatSvg d="down" size={20} /></button>
                    )}
                    <div className="chat-who">{chatWho(m)}</div>
                    {m.reply && (
                      <button type="button" className={`chat-quote ${m.reply.side === "team" ? "out" : "in"}`} onClick={() => jumpTo(m.reply.id)}>
                        <b>{m.reply.side === "team" ? m.reply.who : `${m.reply.who} · client`}</b>
                        <span className={m.reply.text === CHAT_DELETED ? "chat-deleted" : ""}>{m.reply.text || "📎 media"}</span>
                      </button>
                    )}
                    {m.deleted ? <div className="chat-text chat-deleted">⊘ {CHAT_DELETED}</div> : (
                      <>
                        {(m.files || []).map((f) => <ChatMedia key={f.id || f.url} f={f} msg={m} onView={setPhoto} />)}
                        {m.body && <div className="chat-text">{m.body}{m.edited && <span className="chat-edited">edited</span>}</div>}
                      </>
                    )}
                    <div className="chat-time">
                      {!m.deleted && m.edited && !m.body && <span className="chat-edited" style={{ marginLeft: 0, marginRight: 6 }}>edited</span>}
                      {chatDate(m.at)?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      {m.side === "team" && m.status && <ChatTick m={m} onRetry={() => retry(m)} />}
                    </div>
                    {reacts.length > 0 && (
                      <div className="chat-reacts" onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                        {reacts.map((r) => (
                          <button key={r.emoji} type="button" className={`chat-react${r.mine ? " mine" : ""}`} disabled={!canAct}
                            title={r.mine ? "Remove your reaction" : "React too"} onClick={() => act(m, "react", { emoji: r.emoji })}>
                            {r.emoji}{r.count > 1 && <span>{r.count}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {live && (
                    <div className="chat-quick">
                      {canAct && canSend && (
                        <button type="button" aria-label="Reply" title="Reply" onClick={() => quickReply(m)}><ChatSvg d="reply" size={18} /></button>
                      )}
                      <button type="button" aria-label="React" title="React" onClick={() => openCard(m)}><ChatSvg d="smiley" size={18} /></button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {card && <ChatActionCard m={card} canReact={canAct} actions={cardActions(card)} onPick={pick} onClose={() => setCard(null)} />}
      <Modal open={!!info} onClose={() => setInfo(null)} title="Message info" width={340}>
        {info && <ChatInfoLog m={info} />}
      </Modal>
      {photo && <ChatPhotoViewer photo={photo} onClose={() => setPhoto(null)} />}
      {res && !res.error && (res.locked ? <div className="chat-foot mini">🔒 {res.locked}</div>
        : !res.can_send ? <div className="chat-foot mini">This client has no WhatsApp group linked, so messages can’t be sent.</div>
          : (
            <div className="chat-compose">
              {editing && (
                <div className="chat-replying edit">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <b>✎ Editing message</b>
                    <span>{(editing.m.body || "").slice(0, 100)}</span>
                  </div>
                  <IconButton icon="x" label="Cancel edit" size={14} onClick={cancelEdit} />
                </div>
              )}
              {reply && !editing && (
                <div className={`chat-replying ${reply.side === "team" ? "out" : "in"}`}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <b>{chatWho(reply)}</b>
                    <span>{(reply.body || chatFilesLabel(reply.files)).slice(0, 100)}</span>
                  </div>
                  <IconButton icon="x" label="Cancel reply" size={14} onClick={() => setReply(null)} />
                </div>
              )}
              {picked.length > 0 && (
                <div className="chat-chips">
                  {picked.map((p, i) => (
                    <span key={`${p.file.name}${i}`} className="chip-sm" style={CHIP} title={`${p.file.name} · ${fmtBytes(p.file.size)}`}>
                      {p.url ? <img src={p.url} alt="" className="chat-thumb" /> : <span aria-hidden="true">{p.file.type.startsWith("audio/") ? "🎵" : p.file.type.startsWith("video/") ? "🎥" : "📄"}</span>}
                      <span style={ELLIPSIS}>{p.file.name}</span><span className="mini">{fmtBytes(p.file.size)}</span>
                      {!busy && <IconButton icon="x" label={`Remove ${p.file.name}`} size={12} onClick={() => dropFile(i)} />}
                    </span>
                  ))}
                </div>
              )}
              {pickErr && <div className="chat-strip"><Err>{pickErr}</Err></div>}
              {up.prog && <div className="chat-strip"><UploadBar prog={up.prog} onCancel={up.cancel} /></div>}
              {rec ? (
                <div className="chat-foot chat-rec">
                  <button type="button" className="chat-pin" title="Delete recording" aria-label="Delete recording" onClick={recClear}>🗑</button>
                  <span className="chat-rec-time"><span className={`chat-rec-dot${rec.paused ? " paused" : ""}`} aria-hidden="true" />{voiceClock(rec.ms)}</span>
                  {rec.paused ? (
                    <button type="button" className="chat-pin" title={rec.ms >= VOICE_MAX_MS ? "15 minutes is the most one voice note can be" : "Go on recording"} aria-label="Go on recording" disabled={rec.ms >= VOICE_MAX_MS} onClick={resumeRec}>🎙</button>
                  ) : (
                    <button type="button" className="chat-pin" title="Pause" aria-label="Pause recording" onClick={pauseRec}>⏸</button>
                  )}
                  <span className="chat-rec-mid">
                    {rec.paused && (rec.url
                      ? <audio className="chat-rec-audio" controls autoPlay src={rec.url} />
                      : <button type="button" className="chat-pin" title="Listen to it so far" aria-label="Play recording" onClick={playRec}>▶</button>)}
                  </span>
                  <button type="button" className="chat-send" title="Send voice note" aria-label="Send voice note" disabled={busy} onClick={sendRec}><ChatSvg d="send" /></button>
                </div>
              ) : (
              <div className="chat-foot">
                {CHAT_PICK.map(([k, , accept]) => (
                  <input key={k} ref={(el) => { inputs.current[k] = el; }} type="file" hidden accept={accept}
                    multiple={k !== "camera"} capture={k === "camera" ? "environment" : undefined}
                    onChange={(e) => { const add = [...(e.target.files || [])]; e.target.value = ""; if (add.length) addFiles(add); }} />
                ))}
                <div className="chat-pin-wrap" ref={emoRef}>
                  <button type="button" className="chat-pin" title="Emoji" aria-label="Emoji" aria-expanded={emo} onClick={() => setEmo((v) => !v)}><ChatSvg d="smiley" /></button>
                  {emo && (
                    <div className="chat-emo-panel" role="menu" aria-label="Emoji">
                      {CHAT_PANEL.map((em) => (
                        <button key={em} type="button" role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={() => insertEmoji(em)}>{em}</button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="chat-pin-wrap" ref={menuRef}>
                  <button type="button" className="chat-pin chat-clip" title="Attach photos, videos or audio" aria-label="Attach" aria-expanded={menu} disabled={busy || !!editing} onClick={() => setMenu((v) => !v)}><ChatSvg d="clip" /></button>
                  {menu && (
                    <div className="chat-pin-menu" role="menu">
                      {CHAT_PICK.map(([k, label]) => <button key={k} type="button" role="menuitem" onClick={() => choose(k)}>{label}</button>)}
                    </div>
                  )}
                </div>
                <textarea ref={inputRef} className="chat-input" rows={2} value={text} placeholder={editing ? "Edit your message" : picked.length ? "Add a caption (optional)" : "Type a message"}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } else if (e.key === "Escape" && editing) cancelEdit(); else if (e.key === "Escape" && reply) setReply(null); }} />
                {!editing && !text.trim() && !picked.length
                  ? <button type="button" className="chat-send" title="Record a voice note" aria-label="Record a voice note" disabled={busy} onClick={startRec}><ChatSvg d="mic" /></button>
                  : <button type="button" className="chat-send" title={editing ? "Save" : "Send"} disabled={busy || (!text.trim() && (editing || !picked.length))} onClick={send}>{editing ? "✓" : <ChatSvg d="send" />}</button>}
              </div>
              )}
            </div>
          ))}
    </div>
  );
}

/* After the client's check: 👍 Client said finished → 🏁 Full Complete (what is
   still missing is listed) → the bill; 🧾 Bill now when no price matched.
   Renders nothing for tasks that are not that far. */
export function FinishBox({ task, canFinish, isAdmin, onChanged }) {
  const flags = useFlags();
  const [busy, setBusy] = useState("");
  const t = task || {};
  const bill = t.bill && t.bill.id ? t.bill : null;
  if (!t.full_complete_pending && !t.full_complete_at) return null;
  const run = async (key, fn, ok) => {
    setBusy(key);
    try {
      const r = await fn(t.id);
      if (r.status === false) {
        flags.err(r.missing?.length ? `Before Full Complete: ${r.missing.join(" ")}` : r.message);
        return;
      }
      flags.ok(ok(r));
      onChanged?.();
    } catch (e) { flags.err(e.message); } finally { setBusy(""); }
  };
  if (t.full_complete_pending) {
    const missing = t.full_complete_missing || [];
    return (
      <div className="callout" style={{ borderColor: "var(--lz-done, #16a34a)" }}>
        <b>👍 The client said it's finished: needs 🏁 Full Complete</b>
        {missing.length > 0 && <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{missing.map((m) => <li key={m}>{m}</li>)}</ul>}
        {canFinish && <div style={{ marginTop: 8 }}><Button kind="ok" busy={busy === "fc"} onClick={() => run("fc", S.fullComplete, (r) => r.message || "Fully complete.")}>🏁 Full Complete</Button></div>}
      </div>
    );
  }
  if (bill) {
    return (
      <div className="callout">
        <b>🧾 {bill.name} · {bill.money}</b>{" "}
        <Lozenge tone={bill.paid ? "done" : "paused"}>{bill.paid ? "Paid" : bill.client_says_paid ? "Client says paid" : "Unpaid"}</Lozenge>
      </div>
    );
  }
  if (!isAdmin) return null;
  return (
    <div className="callout" style={{ borderColor: "var(--warn, #f59e0b)" }}>
      <b>🏁 Fully complete: no bill yet</b>
      <div className="mini">Usually no price matches this client and work type. Add it in Settings → Configuration → Billing, then:</div>
      <div style={{ marginTop: 8 }}><Button kind="primary" busy={busy === "bn"} onClick={() => run("bn", S.billNow, (r) => (r.bill?.name ? `Bill ${r.bill.name} made: ${r.bill.money}` : "Bill made."))}>🧾 Bill now</Button></div>
    </div>
  );
}

/* ↩ Every time the client sent the work back, newest first: what is still
   wrong and the photos / videos / voice notes that show it
   (models/kpi_client_sendback.py, task.sendbacks). */
export function SendBackHistory({ task }) {
  const rounds = task?.sendbacks || [];
  if (!rounds.length) return null;
  return (
    <div className="sec">
      <h3 style={{ color: "var(--over)" }}>↩ Client sent it back {rounds.length}×</h3>
      {rounds.map((sb) => {
        const d = chatDate(sb.at);
        return (
          <div key={sb.id} className="callout" style={{ marginBottom: 8, borderColor: "var(--over)" }}>
            <div className="mini">Round {sb.round}{sb.by ? ` · ${sb.by}` : ""}{d ? ` · ${d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{sb.reason}</div>
            {sb.files?.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>{sb.files.map((f) => <ChatMedia key={f.id} f={f} />)}</div>}
          </div>
        );
      })}
    </div>
  );
}
