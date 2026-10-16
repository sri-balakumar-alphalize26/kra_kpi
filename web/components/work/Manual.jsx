"use client";
import { useEffect, useState } from "react";
import { Button, ErrorState, Icon, PageHeader, Skeleton, useDialogs, useFlags } from "@/components/ui";
import { useMe } from "@/lib/me";
import * as M from "@/lib/services/more";

/* User manual: the PDFs for your role, opened inline. Admins can add/replace. */
export default function Manual({ portal = false }) {
  const { me } = useMe();
  const flags = useFlags();
  const dlg = useDialogs();
  const [bundle, setBundle] = useState(null);
  const [sel, setSel] = useState(null); /* {id, name, url} */
  const [busy, setBusy] = useState(false);
  const load = () => M.fetchManualBundle().then(setBundle);
  useEffect(() => { load(); }, []);

  const openManual = async (m) => {
    setSel({ id: m.id, name: m.name, url: "" });
    try {
      const r = await M.fetchManualData(m.id);
      if (!r.status || !r.data) { flags.err(r.message || "Could not open."); setSel(null); return; }
      const bytes = atob(r.data); const arr = new Uint8Array(bytes.length); for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([arr], { type: "application/pdf" }));
      setSel({ id: m.id, name: m.name, filename: r.filename, url });
    } catch (e) { flags.err(e.message); setSel(null); }
  };
  const upload = async (e, existing) => {
    const file = e.target.files?.[0]; if (!file) return;
    let name = existing?.name, role = existing?.role;
    if (!existing) {
      const v = await dlg.form({ title: "Add manual", confirmLabel: "Upload", fields: [
        { key: "name", label: "Manual title", value: file.name.replace(/\.pdf$/i, "") },
        { key: "role", label: "Who is it for?", value: "all", options: [{ value: "all", label: "Everyone" }, { value: "developer", label: "Developers" }, { value: "admin", label: "Admins" }, { value: "client", label: "Clients" }] },
      ] });
      if (!v) { e.target.value = ""; return; }
      name = v.name.trim(); role = v.role;
    }
    setBusy(true);
    try {
      const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(file); });
      await M.saveManual({ id: existing?.id, name, filename: file.name, base64: b64, role });
      flags.ok(existing ? "Manual replaced." : "Manual added."); load();
    } catch (ex) { flags.err(ex.message); } finally { setBusy(false); e.target.value = ""; }
  };
  const del = async (m) => { if (!(await dlg.confirm({ title: "Delete manual?", text: `"${m.name}" will be removed for everyone.`, confirmLabel: "Delete", danger: true }))) return; try { await M.deleteManual(m.id); flags.ok("Deleted."); load(); } catch (ex) { flags.err(ex.message); } };

  const manuals = bundle?.manuals || [];
  return (
    <>
      <PageHeader crumbs={[{ label: portal ? "Portal" : "Help" }, { label: "User manual" }]} title="User manual" meta={bundle ? `Guides for your role · ${bundle.role}` : ""}>
        {bundle?.canEdit && <label className="btn btn-primary" style={{ cursor: "pointer" }}><Icon n="upload" size={16} />{busy ? "Uploading…" : "Add manual"}<input type="file" accept="application/pdf" hidden onChange={(e) => upload(e)} /></label>}
      </PageHeader>
      <div className="g12" style={{ flex: 1, minHeight: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {!bundle && <div className="cardbox"><Skeleton rows={3} /></div>}
          {bundle && !bundle.status && <ErrorState error={{ message: bundle.notInstalled ? "The manuals module is not installed on this server." : bundle.message }} onRetry={load} />}
          {bundle?.status && !manuals.length && <div className="cardbox"><span className="mini">No manuals for your role yet.</span></div>}
          {manuals.map((m) => (
            <div key={m.id} className="cardbox" style={{ borderColor: sel?.id === m.id ? "var(--brand)" : undefined }}>
              <h2><span className="icbox" style={{ background: "var(--tint-blue-bg)", color: "var(--tint-blue)" }}><Icon n="book" size={18} /></span>{m.name}</h2>
              <p className="mini" style={{ margin: 0 }}>{m.filename || "PDF"}{m.role ? ` · ${m.role === "all" ? "Everyone" : m.role}` : ""}</p>
              <div className="row">
                <Button kind="primary" size="sm" onClick={() => openManual(m)}>Open</Button>
                {sel?.id === m.id && sel.url && <a className="btn" style={{ height: 28, fontSize: 12.5 }} href={sel.url} download={sel.filename || `${m.name}.pdf`}>Download</a>}
                {bundle.canEdit && <><label className="btn" style={{ height: 28, fontSize: 12.5, cursor: "pointer" }}>Replace<input type="file" accept="application/pdf" hidden onChange={(e) => upload(e, m)} /></label><Button kind="danger" size="sm" onClick={() => del(m)}>Delete</Button></>}
              </div>
            </div>
          ))}
        </div>
        <div className="cardbox" style={{ padding: 0, overflow: "hidden", minHeight: 480 }}>
          <h2 style={{ padding: "14px 16px 0" }}>{sel ? sel.name : "Preview"}{sel?.url && <span className="right"><a className="btn" style={{ height: 28, fontSize: 12 }} href={sel.url} target="_blank" rel="noreferrer">Open in new tab</a></span>}</h2>
          <div style={{ flex: 1, margin: "12px 16px 16px", background: "var(--hover)", borderRadius: 10, minHeight: 420, display: "grid", placeItems: "center" }}>
            {!sel && <span className="mini">Pick a manual on the left.</span>}
            {sel && !sel.url && <Skeleton rows={4} />}
            {sel?.url && <iframe title={sel.name} src={sel.url} style={{ width: "100%", height: "100%", minHeight: 560, border: 0, borderRadius: 10 }} />}
          </div>
        </div>
      </div>
    </>
  );
}
