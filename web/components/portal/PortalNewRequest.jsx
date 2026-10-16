"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Field, Icon, Input, PageHeader, useFlags, Select } from "@/components/ui";
import * as P from "@/lib/services/portal";
import { fileToBase64, humanSize } from "@/lib/services/admin";
import { ymd } from "@/lib/services/reports";

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
  /* What is being built — Module / App / EXE. Required, no default (as in Odoo). */
  const [deliverable, setDeliverable] = useState("");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null); /* {name, neededBy, files} after a successful submit */
  useEffect(() => { P.fetchClientProjects().then((p) => { setProjects(p); if (p[0]) setProject(String(p[0].id)); }).catch((e) => flags.err(e.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addFiles = (e) => { const list = [...(e.target.files || [])]; setFiles((f) => [...f, ...list]); e.target.value = ""; };
  const total = files.reduce((s, f) => s + f.size, 0);
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { flags.err("Give the request a title."); return; }
    if (!project) { flags.err("Pick a project."); return; }
    if (!deliverable) { flags.err("Please choose a type — Module, App or EXE."); return; }
    if (total > MAX_TOTAL) { flags.err("Attachments must be under 25 MB in total."); return; }
    setBusy(true);
    try {
      const attachments = [];
      for (const f of files) attachments.push({ name: f.name, data_b64: await fileToBase64(f), mimetype: f.type || "application/octet-stream" });
      const r = await P.addClientTask({ subKraId: +project, kind, name: name.trim(), description: desc.trim(), priority, deliverableType: deliverable, neededBy: needed, attachments });
      P.assertOk(r, "Could not send the request.");
      /* add_task answers {kpi_id, name, needed_by, attachment_count}. The new task
         is not admin-accepted yet, and the portal lists only accepted tasks, so
         there is nowhere to redirect where it would show — confirm here instead. */
      flags.ok("Request sent.");
      setSent({ name: r.name || name.trim(), neededBy: r.needed_by || "", files: r.attachment_count || 0 });
    } catch (ex) { flags.err(ex.message); } finally { setBusy(false); }
  };
  const another = () => { setSent(null); setName(""); setDesc(""); setNeeded(""); setFiles([]); setPriority("regular"); setDeliverable(""); };

  if (sent) return (
    <>
      <PageHeader crumbs={[{ label: "Portal", href: "/portal" }, { label: "New request" }]} title="Request sent" />
      <div className="page" style={{ maxWidth: 720 }}>
        <div className="cardbox" style={{ gap: 12 }}>
          <span className="icbox" style={{ background: "var(--tint-green-bg)", color: "var(--tint-green)" }}><Icon n="check" size={18} /></span>
          <b style={{ color: "var(--navy)", fontSize: 16 }}>{sent.name}</b>
          <span className="mini">{sent.neededBy ? `Needed by ${sent.neededBy}` : "No needed-by date"}{sent.files ? ` · ${sent.files} file${sent.files === 1 ? "" : "s"} attached` : ""}</span>
          <p className="note" style={{ margin: 0 }}>Your request is with the team. It waits for an admin to accept it, and it appears under Requests once accepted. You'll then be asked to approve the developer and estimate.</p>
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
          <Field label="What kind of request?">
            <div className="grid3">
              {TYPES.map(([k, l, s, ic, bg, fg]) => <button type="button" key={k} className="cardbox" style={{ padding: 12, gap: 4, alignItems: "flex-start", cursor: "pointer", textAlign: "left", borderColor: kind === k ? "var(--brand)" : undefined, background: kind === k ? "var(--hover)" : undefined, font: "inherit" }} onClick={() => setKind(k)}><span className="icbox" style={{ background: bg, color: fg, width: 30, height: 30 }}><Icon n={ic} size={16} /></span><b style={{ color: "var(--navy)" }}>{l}</b><span className="mini">{s}</span></button>)}
            </div>
          </Field>
          <div className="grid2">
            <Field label="Project"><span className="input"><Select value={project} onChange={(e) => setProject(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}>{projects.map((p) => <option key={p.id} value={p.id}>{p.display || p.name}</option>)}{!projects.length && <option value="">Loading…</option>}</Select></span></Field>
            <Field label="How urgent is it?"><span className="input"><Select value={priority} onChange={(e) => setPriority(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}><option value="regular">Normal</option><option value="important">Important</option><option value="urgent">Urgent</option></Select></span></Field>
          </div>
          <div className="grid2" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)" }}>
            <Field label="Title *"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "bug" ? "What is broken" : "What you need"} autoFocus /></Field>
            <Field label="Type (Module / App / EXE) *" error={!deliverable && name.trim() ? "Choose one" : undefined}><span className="input"><Select value={deliverable} onChange={(e) => setDeliverable(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}><option value="">— choose —</option><option value="module">Module</option><option value="app">App</option><option value="exe">EXE</option></Select></span></Field>
          </div>
          <Field label="Describe it"><span className="input ta" style={{ height: 120 }}><textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={kind === "bug" ? "What you did, what happened, what you expected" : "As much detail as you can — screens, rules, examples"} style={{ border: 0, background: "none", outline: 0, resize: "none", width: "100%", height: "100%", font: "inherit", color: "inherit" }} /></span></Field>
          <div className="grid2">
            <Field label="Needed by (optional)"><Input type="date" min={ymd(new Date())} value={needed} onChange={(e) => setNeeded(e.target.value)} /></Field>
            <Field label="Attachments (optional)"><label className="dropzone" style={{ padding: 12, cursor: "pointer" }}><b>Add screenshots or files</b>up to 25 MB in total · {files.length ? `${files.length} selected · ${humanSize(total)}` : "none yet"}<input type="file" multiple hidden onChange={addFiles} /></label></Field>
          </div>
          {files.length > 0 && <div className="pillset">{files.map((f, i) => <span key={i} className="chip-sm" style={{ background: "var(--hover)", color: "var(--navy)" }}><Icon n="paperclip" size={13} />{f.name} · {humanSize(f.size)}<button type="button" className="icon-btn" style={{ width: 20, height: 20 }} aria-label="Remove" onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}><Icon n="x" size={12} /></button></span>)}</div>}
          <div className="row"><Button kind="primary" size="lg" type="submit" busy={busy} style={{ padding: "0 24px" }}>Send request</Button><span className="mini">You'll get a WhatsApp message when it's estimated.</span></div>
        </form>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="cardbox"><h2>Have a list?</h2><p className="mini" style={{ margin: 0 }}>Upload an XLSX or CSV with many requests at once; each becomes a task.</p><Link className="btn" href="/portal/requests/bulk" style={{ alignSelf: "flex-start" }}>Upload a list</Link></div>
          <div className="cardbox"><h2>What happens next</h2>
            <div className="steps" style={{ flexDirection: "column", alignItems: "flex-start", gap: 10 }}><span className="on"><b>1</b>You send the request</span><span><b>2</b>The team estimates and assigns it (usually the same day)</span><span><b>3</b>You approve the estimate on WhatsApp or here</span><span><b>4</b>Work happens — you see progress live</span><span><b>5</b>You sign off · certificate issued · invoiced</span></div>
          </div>
        </div>
      </div>
    </>
  );
}
