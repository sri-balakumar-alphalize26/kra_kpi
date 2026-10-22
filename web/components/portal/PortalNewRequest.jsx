"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Field, Icon, Input, Lozenge, Modal, PageHeader, useFlags, Select } from "@/components/ui";
import * as P from "@/lib/services/portal";
import { fileToBase64, humanSize } from "@/lib/services/admin";
import { ymd } from "@/lib/services/reports";
import { DELIVERABLES, DELIVERABLE_OTHER_REQUIRED, deliverableOtherValue } from "@/lib/services/kpiActions";
import OtherTypeInput from "@/components/task/OtherTypeInput";
import VoiceRecorder from "@/components/task/VoiceRecorder";
import * as L from "@/lib/services/legacy";

/* Raise one request (requirement / update / bug) with needed-by date and
   attachments → /kpi_client_portal/add_task. Bulk upload lives in Intake. */
const TYPES = [["requirement", "New requirement", "Something new to build", "plus", "var(--tint-blue-bg)", "var(--tint-blue)"], ["update", "Update", "Change something existing", "pen", "var(--tint-green-bg)", "var(--tint-green)"], ["bug", "Bug", "Something is broken", "warn", "var(--tint-red-bg)", "var(--tint-red)"]];
const MAX_TOTAL = 25 * 1024 * 1024;

export default function PortalNewRequest({ type: initial = "requirement" }) {
  const flags = useFlags();
  const router = useRouter();
  const [kind, setKind] = useState(initial);
  const [projects, setProjects] = useState([]); const [project, setProject] = useState("");
  const [name, setName] = useState(""); const [desc, setDesc] = useState("");
  const [priority, setPriority] = useState("regular"); const [needed, setNeeded] = useState("");
  /* What is being built — Module / App / EXE / Other. Required, no default (as in Odoo).
     Other needs a short name of what it is (deliverableOther). */
  const [deliverable, setDeliverable] = useState("");
  const [deliverableOther, setDeliverableOther] = useState("");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null); /* {name, neededBy, files} after a successful submit */
  /* Bug / Update: the requirement it is about, picked from the project's REQs, newest first. */
  const [parents, setParents] = useState(null); const [parentId, setParentId] = useState(""); const [parentQ, setParentQ] = useState("");
  /* "Are you sure all details are accurate?" — ticked before anything is sent. */
  const [confirming, setConfirming] = useState(false); const [agreed, setAgreed] = useState(false);
  /* 🗄️ From the old system: the requirement is not in this list, so the request
     says what it is about instead: a photo / video of the old screen, a voice
     note, a message, its Request ID or its name (any ONE, lib/services/legacy). */
  const [legacyOn, setLegacyOn] = useState(false);
  const [legacyRef, setLegacyRef] = useState(""); const [legacyName, setLegacyName] = useState(""); const [legacyNote, setLegacyNote] = useState("");
  const [micMsg, setMicMsg] = useState(""); /* "Can't use the mic", until the next change */
  const noteRef = useRef(null);
  const child = kind === "bug" || kind === "update";
  const oldDb = child && legacyOn;
  const problem = oldDb ? L.legacyProblem({ ref: legacyRef, name: legacyName, note: legacyNote, files }) : "";
  useEffect(() => { setMicMsg(""); }, [legacyRef, legacyName, legacyNote, files]);
  const micFailed = () => { setMicMsg(L.MIC_FAILED); noteRef.current?.focus(); };
  /* Camera files all arrive as image.jpg / video.mp4: give each its own name. */
  const addShot = (e, isVideo) => {
    const f = e.target.files?.[0]; e.target.value = "";
    if (!f) return;
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, "");
    const ext = (f.name.match(/\.[A-Za-z0-9]+$/) || [isVideo ? ".mp4" : ".jpg"])[0];
    setFiles((fs) => [...fs, new File([f], `${isVideo ? "Video" : "Photo"} ${stamp}${ext}`, { type: f.type })]);
  };
  useEffect(() => { P.fetchClientProjects().then((p) => { setProjects(p); if (p[0]) setProject(String(p[0].id)); }).catch((e) => flags.err(e.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!child || !project) { setParents(null); return; }
    setParents(null); setParentId("");
    P.fetchParentTasks(project).then(setParents).catch(() => setParents([]));
  }, [child, project]);
  /* The bugs / updates already raised under the picked requirement, and the
     ref this one gets ("This one will be BUG003-REQ-012"). */
  const [kids, setKids] = useState(null);
  useEffect(() => {
    if (!child || !parentId || legacyOn) { setKids(null); return; }
    let live = true;
    setKids({ loading: true });
    P.fetchChildren(parentId, kind).then((r) => { if (live) setKids(r); }).catch(() => { if (live) setKids(null); });
    return () => { live = false; };
  }, [child, parentId, kind, legacyOn]);
  const q = parentQ.trim().toLowerCase();
  const shownParents = (parents || []).filter((t) => !q || `${t.ref} ${t.name}`.toLowerCase().includes(q));

  const addFiles = (e) => { const list = [...(e.target.files || [])]; setFiles((f) => [...f, ...list]); e.target.value = ""; };
  const total = files.reduce((s, f) => s + f.size, 0);
  const otherText = deliverableOtherValue(deliverable, deliverableOther);
  /* Checks first, then the confirm popup; send() runs from the popup. */
  const submit = (e) => {
    e.preventDefault();
    if (!name.trim()) { flags.err("Give the request a title."); return; }
    if (!project) { flags.err("Pick a project."); return; }
    if (child && !legacyOn && !parentId) { flags.err("Pick the task this is about, or tick “It's from the old system”."); return; }
    if (problem) { flags.err(problem); return; }
    if (!child && !deliverable) { flags.err("Please choose a type — Module, App, EXE or Other."); return; }
    if (!child && deliverable === "other" && !otherText) { flags.err(DELIVERABLE_OTHER_REQUIRED); return; }
    if (total > MAX_TOTAL) { flags.err("Attachments must be under 25 MB in total."); return; }
    setAgreed(false); setConfirming(true);
  };
  const send = async () => {
    if (!agreed) return;
    setBusy(true);
    try {
      const attachments = [];
      for (const f of files) attachments.push({ name: f.name, data_b64: await fileToBase64(f), mimetype: f.type || "application/octet-stream" });
      const r = await P.addClientTask({ subKraId: +project, kind, name: name.trim(), description: desc.trim(), priority, deliverableType: child ? "" : deliverable, deliverableOther: child ? "" : otherText, neededBy: needed, attachments, parentId: child && !legacyOn ? +parentId : 0,
        legacyOn: oldDb, legacyRef: legacyRef.trim(), legacyName: legacyName.trim(), legacyNote: legacyNote.trim() });
      P.assertOk(r, "Could not send the request.");
      /* add_task answers {kpi_id, name, needed_by, attachment_count}. The new task
         is not admin-accepted yet, and the portal lists only accepted tasks, so
         there is nowhere to redirect where it would show — confirm here instead. */
      flags.ok("Request sent.");
      setConfirming(false);
      setSent({ name: r.name || name.trim(), neededBy: r.needed_by || "", files: r.attachment_count || 0 });
    } catch (ex) { flags.err(ex.message); } finally { setBusy(false); }
  };
  const another = () => { setSent(null); setParentId(""); setParentQ(""); setName(""); setDesc(""); setNeeded(""); setFiles([]); setPriority("regular"); setDeliverable(""); setDeliverableOther(""); setLegacyOn(false); setLegacyRef(""); setLegacyName(""); setLegacyNote(""); };

  if (sent) return (
    <>
      <PageHeader crumbs={[{ label: "Portal", href: "/portal" }, { label: "New request" }]} title="Request sent" />
      <div className="page" style={{ maxWidth: 720 }}>
        <div className="cardbox" style={{ gap: 12 }}>
          <span className="icbox" style={{ background: "var(--tint-green-bg)", color: "var(--tint-green)" }}><Icon n="check" size={18} /></span>
          <b style={{ color: "var(--navy)", fontSize: 16 }}>{sent.name}</b>
          <span className="mini">{sent.neededBy ? `Needed by ${sent.neededBy}` : "No needed-by date"}{sent.files ? ` · ${sent.files} file${sent.files === 1 ? "" : "s"} attached` : ""}</span>
          <p className="note" style={{ margin: 0 }}>Your request is with the team. It waits for an admin to accept it, and it appears under Requests once accepted. Work starts as soon as the team assigns it.</p>
          <div className="row" style={{ flexWrap: "wrap" }}><Button kind="primary" onClick={another}>Send another request</Button><Button kind="ghost" onClick={() => router.push("/portal")}>Back to home</Button></div>
        </div>
      </div>
    </>
  );

  return (
    <>
      <PageHeader crumbs={[{ label: "Portal", href: "/portal" }, { label: "New request" }]} title="New request" meta="We'll estimate it and come back to you for approval" />
      <div className="g21" style={{ flex: 1, minHeight: 0, maxWidth: 1180 }}>
        <form className="cardbox" style={{ gap: 14 }} onSubmit={submit}>
          <div className="warn-banner" role="alert"><span>⚠️ Write a clear, proper task name and description. No random or confusing text — the developer must understand exactly what you need.</span></div>
          <Field label="What kind of request?">
            <div className="grid3">
              {TYPES.map(([k, l, s, ic, bg, fg]) => <button type="button" key={k} className="cardbox" style={{ padding: 12, gap: 4, alignItems: "flex-start", cursor: "pointer", textAlign: "left", borderColor: kind === k ? "var(--brand)" : undefined, background: kind === k ? "var(--hover)" : undefined, font: "inherit" }} onClick={() => setKind(k)}><span className="icbox" style={{ background: bg, color: fg, width: 30, height: 30 }}><Icon n={ic} size={16} /></span><b style={{ color: "var(--navy)" }}>{l}</b><span className="mini">{s}</span></button>)}
            </div>
          </Field>
          <div className="grid2">
            <Field label="Project" required><span className="input"><Select value={project} onChange={(e) => setProject(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}>{projects.map((p) => <option key={p.id} value={p.id}>{p.display || p.name}</option>)}{!projects.length && <option value="">Loading…</option>}</Select></span></Field>
            <Field label="How urgent is it?"><span className="input"><Select value={priority} onChange={(e) => setPriority(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}><option value="regular">Normal</option><option value="important">Important</option><option value="urgent">Urgent</option></Select></span></Field>
          </div>
          {child && (
            <>
              {!legacyOn && (
                <Field label="Which task is it about?" required hint="Newest first. The new request is numbered under it, e.g. BUG001-REQ-012.">
                  <Input id="pnr-parent-q" icon="search" value={parentQ} onChange={(e) => setParentQ(e.target.value)} placeholder="Search by number or name" />
                  <div className="parent-list" role="radiogroup" aria-label="Task it is about">
                    {parents === null && <span className="mini">Loading tasks…</span>}
                    {parents && !parents.length && <span className="mini">This project has no requirements yet — tick “It's from the old system” below, or send a New requirement.</span>}
                    {parents && parents.length > 0 && !shownParents.length && <span className="mini">No task matches that search.</span>}
                    {shownParents.map((t) => (
                      <label key={t.id} className={String(t.id) === parentId ? "on" : ""}>
                        <input type="radio" name="parent" value={t.id} checked={String(t.id) === parentId} onChange={() => setParentId(String(t.id))} />
                        <span><b>{t.ref}</b> {t.name}{t.old && <Lozenge tone="review" style={{ textTransform: "none", marginLeft: 6 }}>Old DB</Lozenge>}<small>{t.date}{t.db ? ` · ${t.db}` : ""}</small></span>
                      </label>
                    ))}
                  </div>
                  {kids && (
                    <div className="cardbox" style={{ gap: 6, padding: 10 }}>
                      {kids.loading ? <span className="mini">Checking earlier {kind === "bug" ? "bugs" : "updates"}…</span> : (
                        <>
                          <b>{kids.items?.length ? `${kind === "bug" ? "🐞" : "🔧"} Already raised under ${kids.parent}:` : `No ${kind === "bug" ? "bugs" : "updates"} under ${kids.parent} yet.`}</b>
                          {(kids.items || []).map((k) => (
                            <span key={k.ref}><b style={{ color: "var(--brand)", marginRight: 6 }}>{k.ref}</b>{k.name}<small className="mini" style={{ display: "block" }}>{k.status}{k.date ? ` · ${k.date}` : ""}</small></span>
                          ))}
                          {kids.next_ref && <b>➜ This one will be {kids.next_ref}</b>}
                        </>
                      )}
                    </div>
                  )}
                </Field>
              )}
              {/* Its own label, outside the Field: a click anywhere in the list must not tick it. */}
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 700, cursor: "pointer" }}>
                <input id="pnr-old" type="checkbox" checked={legacyOn} onChange={(e) => { setLegacyOn(e.target.checked); if (e.target.checked) setParentId(""); }} />
                <span>🗄️ It&apos;s from the old system — not in this list</span>
              </label>
            </>
          )}
          {oldDb && (
            <div id="pnr-old-box" className="cardbox" style={{ gap: 10, background: "var(--lz-review-bg)", borderColor: "var(--lz-review)" }}>
              <span><Lozenge tone="review" style={{ textTransform: "none" }}>🗄️ Old DB Requirement</Lozenge></span>
              <span className="mini">{L.BEST_HINT}</span>
              <div className="pillset" style={{ flexWrap: "wrap" }}>
                <label className="btn btn-primary" style={{ cursor: "pointer" }}>📷 Photo<input type="file" accept="image/*" capture="environment" hidden onChange={(e) => addShot(e, false)} /></label>
                <label className="btn btn-primary" style={{ cursor: "pointer" }}>🎥 Video<input type="file" accept="video/*" capture="environment" hidden onChange={(e) => addShot(e, true)} /></label>
                <VoiceRecorder onAttach={(f) => setFiles((fs) => [...fs, f])} onMicFailed={micFailed} />
              </div>
              <div className="grid2">
                <Field label="Request ID (optional)"><Input value={legacyRef} onChange={(e) => setLegacyRef(e.target.value)} onBlur={() => setLegacyRef((v) => L.normalizeRef(v))} placeholder="REQ-012" /></Field>
                <Field label="Task name (optional)"><Input value={legacyName} onChange={(e) => setLegacyName(e.target.value)} placeholder="Its name in the old system" /></Field>
              </div>
              <Field label="Message"><span className="input ta" style={{ height: 90 }}><textarea ref={noteRef} value={legacyNote} onChange={(e) => setLegacyNote(e.target.value)} placeholder="Which screen, what it does today, what is wrong or should change" style={{ border: 0, background: "none", outline: 0, resize: "none", width: "100%", height: "100%", font: "inherit", color: "inherit" }} /></span></Field>
              <small role="status" style={{ fontSize: 12.5, fontWeight: 700, color: micMsg || problem ? "var(--danger)" : "var(--tint-green)" }}>{micMsg || problem || L.ENOUGH}</small>
            </div>
          )}
          <div className="grid2" style={child ? undefined : { gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)" }}>
            <Field label="Title" required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "bug" ? "What is broken" : "What you need"} autoFocus /></Field>
            {!child && <Field label="Type (Module / App / EXE / Other)" required error={!deliverable && name.trim() ? "Choose one" : undefined}><span className="input"><Select value={deliverable} onChange={(e) => setDeliverable(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}><option value="">— choose —</option>{DELIVERABLES.map((d) => <option key={d.code} value={d.code}>{d.label}</option>)}</Select></span></Field>}
          </div>
          {!child && deliverable === "other" && <OtherTypeInput value={deliverableOther} onChange={setDeliverableOther} autoFocus />}
          <Field label="Describe it"><span className="input ta" style={{ height: 120 }}><textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={kind === "bug" ? "What you did, what happened, what you expected" : "As much detail as you can — screens, rules, examples"} style={{ border: 0, background: "none", outline: 0, resize: "none", width: "100%", height: "100%", font: "inherit", color: "inherit" }} /></span></Field>
          <div className="grid2">
            <Field label="Needed by (optional)"><Input type="date" min={ymd(new Date())} value={needed} onChange={(e) => setNeeded(e.target.value)} /></Field>
            <Field label="Attachments (optional)"><label className="dropzone" style={{ padding: 12, cursor: "pointer" }}><b>Add screenshots or files</b>up to 25 MB in total · {files.length ? `${files.length} selected · ${humanSize(total)}` : "none yet"}<input type="file" multiple hidden onChange={addFiles} /></label></Field>
          </div>
          {/* Camera / mic shortcuts for every request (the old-system box has its own). */}
          {!oldDb && (
            <div className="pillset" style={{ flexWrap: "wrap" }}>
              <label className="btn" style={{ cursor: "pointer" }}>📷 Photo<input type="file" accept="image/*" capture="environment" hidden onChange={(e) => addShot(e, false)} /></label>
              <label className="btn" style={{ cursor: "pointer" }}>🎥 Video<input type="file" accept="video/*" capture="environment" hidden onChange={(e) => addShot(e, true)} /></label>
              <VoiceRecorder onAttach={(f) => setFiles((fs) => [...fs, f])} onMicFailed={() => flags.err(L.MIC_FAILED)} />
            </div>
          )}
          {files.length > 0 && <div className="pillset">{files.map((f, i) => <span key={i} className="chip-sm" style={{ background: "var(--hover)", color: "var(--navy)" }}><Icon n="paperclip" size={13} />{f.name} · {humanSize(f.size)}<button type="button" className="icon-btn" style={{ width: 20, height: 20 }} aria-label="Remove" onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}><Icon n="x" size={12} /></button></span>)}</div>}
          <div className="row"><Button kind="primary" size="lg" type="submit" busy={busy} disabled={!!problem} title={problem || undefined} style={{ padding: "0 24px" }}>Send request</Button><span className="mini">You'll get a WhatsApp message when it's estimated.</span></div>
        </form>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="cardbox"><h2>Have a list?</h2><p className="mini" style={{ margin: 0 }}>Upload an XLSX or CSV with many requests at once; each becomes a task.</p><Link className="btn" href="/portal/requests/bulk" style={{ alignSelf: "flex-start" }}>Upload a list</Link></div>
          <div className="cardbox"><h2>What happens next</h2>
            <div className="steps" style={{ flexDirection: "column", alignItems: "flex-start", gap: 10 }}><span className="on"><b>1</b>You send the request</span><span><b>2</b>An admin accepts it, estimates and assigns it (usually the same day)</span><span><b>3</b>Work happens — you see progress live</span><span><b>4</b>You sign off · certificate issued · invoiced</span></div>
          </div>
        </div>
      </div>
      <Modal open={confirming} onClose={() => !busy && setConfirming(false)} title="Send this request?" footer={<><Button kind="ghost" onClick={() => setConfirming(false)} disabled={busy}>Back</Button><Button kind="primary" busy={busy} disabled={!agreed} onClick={send}>Confirm</Button></>}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span><b>{name.trim()}</b>{oldDb ? <span className="mini"> · about 🗄️ an Old DB requirement{legacyRef.trim() ? ` (${legacyRef.trim()})` : ""}</span> : child && parentId ? <span className="mini"> · about {(parents || []).find((t) => String(t.id) === parentId)?.ref}</span> : null}</span>
          <span className="mini">{TYPES.find((x) => x[0] === kind)?.[1]} · {projects.find((p) => String(p.id) === project)?.name || ""}{files.length ? ` · ${files.length} file${files.length === 1 ? "" : "s"}` : ""}</span>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontWeight: 700, cursor: "pointer" }}>
            <input id="pnr-agree" type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginTop: 3 }} />
            <span>Are you sure all details are accurate? I agree to submit.</span>
          </label>
        </div>
      </Modal>
    </>
  );
}
