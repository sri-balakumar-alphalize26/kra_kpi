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
      <Input icon="link" value={links} onChange={(e) => setLinks(e.target.value)} disabled={busy} placeholder="Links (optional) — Drive, GitHub, … separated by spaces" />
      {/* A link already on the task blocks posting until it is taken out, as Odoo's Add Link does. */}
      <DupLine text={linkDup} />
      <div className="pillset" style={{ alignItems: "center" }}>
        <FilePicker files={files} setFiles={setFiles} onPick={pick} disabled={busy} />
        <span style={{ marginLeft: "auto" }}><Button kind="primary" size="sm" busy={busy} disabled={!summary.trim() || !!linkDup} onClick={post}>Post</Button></span>
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
            <Input icon="link" value={edit.links} onChange={(e) => setEdit((v) => ({ ...v, links: e.target.value }))} placeholder="Links, separated by spaces" />
            {p.has_file && <label className="chk"><input type="checkbox" checked={edit.clearFile} onChange={(e) => setEdit((v) => ({ ...v, clearFile: e.target.checked }))} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} />Remove the file “{p.file_name || "file"}”</label>}
            <div className="pillset"><Button size="sm" kind="ghost" onClick={() => { setEdit(null); setErr(""); }}>Cancel</Button><Button size="sm" kind="primary" busy={busy} disabled={!edit.summary.trim()} onClick={save}>Save</Button></div>
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
  return (
    <div className="sec" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {!canAdd && <NotStartedNote />}
      {(canAdd || manuals.length > 0) && <Manuals kpiId={kpiId} manuals={manuals} progress={d.progress || []} linkIdx={linkIdx} canAdd={canAdd} onChanged={onChanged} />}
      <Github kpiId={kpiId} github={d.github || []} linkIdx={linkIdx} canAdd={canAdd} canDelete={canManageGithub} onChanged={onChanged} />
      <div>
        <h3>Attached to updates{d.files?.length ? ` · ${d.files.length}` : ""}</h3>
        {(d.files || []).map((f) => (
          <div key={`f${f.id}`} className="kv" style={{ padding: "6px 0" }}>
            <FileBadge kind={fileKind(f.file_name)} />
            <a className="val" href={href(`/kpi/progress/view?progress_id=${f.id}`)} target="_blank" rel="noreferrer" style={{ ...ELLIPSIS, textDecoration: "none", minWidth: 0 }}>{f.file_name || "file"}</a>
            <span className="right mini">{f.uploaded_by} · {fmtFriendly(f.upload_date)}<a className="icon-btn" href={href(`/kpi/progress/download?progress_id=${f.id}`)} title="Download" aria-label="Download"><Icon n="download" size={15} /></a></span>
          </div>
        ))}
        {!d.files?.length && <span className="mini">No files on progress updates yet.</span>}
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
          <Input icon="link" value={mlinks} onChange={(e) => setMlinks(e.target.value)} disabled={busy} placeholder="Related links (optional) — separated by spaces" />
          <DupLine text={mlinkDup} />
          <LargeFileNote mb={25} />
          {up.prog && <UploadBar prog={up.prog} onCancel={up.cancel} />}
          <div className="pillset"><Button size="sm" kind="ghost" disabled={busy} onClick={() => { setOpen(false); setFiles([]); setErr(""); }}>Cancel</Button><Button size="sm" kind="primary" busy={busy} disabled={!files.length || !!mlinkDup} onClick={send}>Upload</Button></div>
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
  const notGit = !key.startsWith("github.com/") && key.includes(".")
    ? (already || "Only GitHub repository links can be added here. Add other links under Related Links.") : "";
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
  const [tries, setTries] = useState(0); /* Retry after a dropped request reloads the log */
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
  }, [kpiId, kind, tries]);
  const src = kind === "all" ? d : log || { activity_log: [], activity_total: 0, activity_limit: 0 };
  const rows = src.activity_log || [];
  const shown = all ? rows : rows.slice(0, SHOWN);
  const est = d.estimate_history || [];
  return (
    <div className="sec" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Tabs items={KINDS} value={kind} onChange={setKind} />
      {log === undefined && <span className="mini" style={{ padding: "8px 0" }}>Loading…</span>}
      {err && <span style={{ display: "flex", alignItems: "center", gap: 8 }}><Err>{err}</Err><Button size="sm" kind="ghost" onClick={() => setTries((n) => n + 1)}>Retry</Button></span>}
      {shown.map((a) => {
        const txt = describe(a);
        return (
          <div key={a.id} className="notif" style={{ padding: "8px 0" }}>
            <span className="icbox" style={{ background: a.success === false ? "var(--over-bg)" : "var(--hover)", color: a.success === false ? "var(--over)" : "var(--subtle)", width: 28, height: 28 }}><Icon n={a.success === false ? "warn" : eventIcon(a.event)} size={14} /></span>
            <div style={{ minWidth: 0 }}><p style={{ overflowWrap: "anywhere" }}>{a.label}{txt ? <span style={{ color: "var(--subtle)" }}> — {txt}</span> : null}</p><small>{a.at}{a.actor ? ` · ${a.actor}` : ""}</small></div>
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
