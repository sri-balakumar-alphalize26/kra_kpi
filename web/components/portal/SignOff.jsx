"use client";
import { useEffect, useState } from "react";
import { Button, Field, Input, Modal, Skeleton, useFlags } from "@/components/ui";
import * as P from "@/lib/services/portal";
import { fileToBase64 } from "@/lib/services/admin";

/* Pieces of the client's sign-off, shared by the single sheet and the bulk dialog:
   the certificate preview, and the signature block (typed name, saved signature
   image, the three confirmations the server insists on, a note).

   The server refuses a sign-off with no typed name unless a signature image is
   on file (_resolve_client_signature), so the name is prefilled and required. */
const CHECKS = [
  ["delivered", "The work described has been delivered."],
  ["works", "It works as agreed."],
  ["authorized", "I am authorised to accept it for my company."],
];
const today = () => new Date().toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });

export function useSignature(defaultName) {
  const [name, setName] = useState(defaultName || "");
  const [chk, setChk] = useState({ delivered: false, works: false, authorized: false });
  const [notes, setNotes] = useState("");
  const [sig, setSig] = useState(null);
  useEffect(() => { P.fetchSignature().then(setSig); }, []);
  const allChecked = CHECKS.every(([k]) => chk[k]);
  const ready = allChecked && (name.trim() || sig?.hasSignature);
  return { name, setName, chk, setChk, notes, setNotes, sig, setSig, allChecked, ready };
}

/* "Your saved signature" (Odoo's Completions card): upload once, it is used on
   every sign-off; Remove falls back to typing your name. Confirmed inline. */
export function SignatureCard() {
  const flags = useFlags();
  const [sig, setSig] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0); /* reset the file box so the same file can be picked again */
  useEffect(() => { P.fetchSignature().then(setSig); }, []);
  const upload = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    setBusy(true);
    try { const b64 = await fileToBase64(f); P.assertOk(await P.uploadSignature(b64, f.name), "Upload failed."); setSig(await P.fetchSignature()); setConfirm(false); flags.ok("Signature saved. It will auto-load on every sign-off."); }
    catch (ex) { flags.err(ex.message); } finally { setBusy(false); setInputKey((k) => k + 1); }
  };
  const remove = async () => {
    setBusy(true);
    try { P.assertOk(await P.removeSignature(), "Could not remove."); setSig({ hasSignature: false, imageB64: "" }); setConfirm(false); setInputKey((k) => k + 1); flags.ok("Signature removed. You will type your name on each sign-off."); }
    catch (ex) { flags.err(ex.message); } finally { setBusy(false); }
  };
  return (
    <div className="cardbox" style={{ borderLeft: "4px solid var(--tint-blue)", flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
      <div style={{ flex: "1 1 320px", display: "flex", flexDirection: "column", gap: 6 }}>
        <b style={{ color: "var(--navy)" }}>Your saved signature</b>
        <span className="mini">Upload your signature image once (PNG/JPG). It auto-loads on the sign-off for every task — you just confirm to approve.</span>
        <label className="btn" style={{ height: 30, alignSelf: "flex-start", cursor: busy ? "wait" : "pointer" }}>{sig?.hasSignature ? "Replace image" : "Upload image"}<input key={inputKey} type="file" accept=".png,.jpg,.jpeg" hidden disabled={busy} onChange={upload} /></label>
      </div>
      <div style={{ flex: "0 1 300px", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
        {!sig && <Skeleton rows={1} />}
        {sig && !sig.hasSignature && <span className="mini">No signature uploaded yet</span>}
        {sig?.hasSignature && (
          <>
            <img src={`data:image/png;base64,${sig.imageB64}`} alt="Saved signature" style={{ maxHeight: 80, maxWidth: 280, border: "1px solid var(--border)", borderRadius: 4, background: "#fff", padding: 4 }} />
            {!confirm
              ? <Button size="sm" kind="ghost" onClick={() => setConfirm(true)}>Remove</Button>
              : <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><span className="mini" style={{ color: "var(--danger)" }}>Remove signature?</span><Button size="sm" kind="danger" busy={busy} onClick={remove}>Yes, remove</Button><Button size="sm" kind="ghost" onClick={() => setConfirm(false)}>Cancel</Button></span>}
          </>
        )}
      </div>
    </div>
  );
}

export function SignatureFields({ s, compact }) {
  const flags = useFlags();
  const uploadSig = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try { const b64 = await fileToBase64(f); P.assertOk(await P.uploadSignature(b64, f.name)); s.setSig(await P.fetchSignature()); flags.ok("Signature saved."); }
    catch (ex) { flags.err(ex.message); }
  };
  return (
    <>
      <Field label="Signed by (type your full name)" error={!s.name.trim() && !s.sig?.hasSignature ? "Type your name to sign." : undefined}>
        <Input value={s.name} onChange={(e) => s.setName(e.target.value)} placeholder="Your full name" autoComplete="name" />
      </Field>
      <div className="kv" style={{ padding: "6px 0" }}>
        <span className="lbl" style={{ minWidth: 100 }}>Signature</span>
        {s.sig?.hasSignature ? <img src={`data:image/png;base64,${s.sig.imageB64}`} alt="Your signature" style={{ height: 44 }} /> : <span className="mini">Your typed name is used</span>}
        <label className="btn" style={{ height: 26, fontSize: 12, marginLeft: "auto", cursor: "pointer" }}>{s.sig?.hasSignature ? "Replace image" : "Upload image"}<input type="file" accept="image/*" hidden onChange={uploadSig} /></label>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {CHECKS.map(([k, label]) => (
          <label key={k} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13.5, cursor: "pointer" }}>
            <input type="checkbox" checked={!!s.chk[k]} onChange={(e) => s.setChk({ ...s.chk, [k]: e.target.checked })} style={{ marginTop: 3 }} />{label}
          </label>
        ))}
      </div>
      {!compact && (
        <Field label="Comment to the team (optional)">
          <span className="input ta" style={{ height: 64 }}><textarea value={s.notes} onChange={(e) => s.setNotes(e.target.value)} style={{ border: 0, background: "none", outline: 0, resize: "none", width: "100%", height: "100%", font: "inherit", color: "inherit" }} /></span>
        </Field>
      )}
    </>
  );
}

/* What the completion certificate will say, before it is signed. Hours are left
   out on purpose — the issued certificate does not print them either. */
export function CertificatePreview({ kpiId, signer, sig }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    setD(null); setErr("");
    P.fetchApprovalDetail(kpiId).then((r) => { if (!alive) return; if (r?.status === false) setErr(r.message || "Preview unavailable."); else setD(r?.data || null); }).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [kpiId]);
  if (err) return <span className="mini" style={{ color: "var(--danger)" }}>{err}</span>;
  if (!d) return <Skeleton rows={4} />;
  const k = d.kpi || {};
  const rows = [
    ["Client", d.client_name], ["Project", d.project_name], ["Reference", k.external_ref], ["Delivered version", k.delivery_version],
    ["Requirement version", k.requirement_version], ["Assigned", k.assigned_date], ["Completed", k.completion_date],
    ["Checked by", k.approved_by ? `${k.approved_by}${k.approval_date ? ` · ${k.approval_date}` : ""}` : ""],
  ].filter(([, v]) => v);
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }} aria-label="Certificate preview">
      <div style={{ background: "#38385C", color: "#fff", padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
        {d.company_logo_b64 && <img src={`data:image/png;base64,${d.company_logo_b64}`} alt="" style={{ height: 28, width: 28, objectFit: "contain", background: "#fff", borderRadius: 6 }} />}
        <span style={{ display: "flex", flexDirection: "column" }}><b style={{ fontSize: 14 }}>Completion certificate</b><span style={{ fontSize: 11.5, opacity: 0.85 }}>{d.company_name}</span></span>
        <span style={{ marginLeft: "auto", fontSize: 11.5, opacity: 0.85 }}>Preview</span>
      </div>
      <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
        <b style={{ color: "var(--navy)", fontSize: 15 }}>{k.name}</b>
        {k.description && <p style={{ margin: 0, fontSize: 12.5, whiteSpace: "pre-wrap", maxHeight: 90, overflow: "auto" }}>{k.description}</p>}
        <dl className="details" style={{ margin: 0 }}>{rows.map(([a, b]) => <span key={a} style={{ display: "contents" }}><dt>{a}</dt><dd>{b}</dd></span>)}</dl>
        <div style={{ borderTop: "1px dashed var(--border)", paddingTop: 8, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span className="mini">Accepted by</span>
          {sig?.hasSignature && <img src={`data:image/png;base64,${sig.imageB64}`} alt="" style={{ height: 32 }} />}
          <b style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontStyle: "italic", fontSize: 16, color: "var(--navy)" }}>{signer || "—"}</b>
          <span className="mini" style={{ marginLeft: "auto" }}>{today()}</span>
        </div>
      </div>
    </div>
  );
}

/* Sign several finished tasks off in one go. Each one is checked on its own by
   the server; the ones it refuses come back with a reason. */
export function BulkSignOff({ tasks, defaultName, onClose, onDone }) {
  const flags = useFlags();
  const s = useSignature(defaultName);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const submit = async () => {
    setBusy(true);
    try {
      const r = P.assertOk(await P.signOffBulk(tasks.map((t) => t.id), { signatureText: s.name, notes: s.notes }), "Could not sign off.");
      setResult(r);
      const n = (r.approved || []).length, sk = (r.skipped || []).length;
      if (n) flags.ok(`Signed off ${n} task${n === 1 ? "" : "s"} — certificates issued.`);
      if (sk) flags.warn(`${sk} not signed — see why.`);
      onDone(r);
    } catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  if (result) {
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
    return (
      <Modal open onClose={onClose} title="Sign-off result" width={560} footer={<Button kind="primary" onClick={onClose}>Done</Button>}>
        <p style={{ margin: 0 }}>{result.message}</p>
        {(result.approved || []).length > 0 && <div className="mini">Signed: {(result.approved || []).map((id) => byId[id]?.external_ref || byId[id]?.name || `#${id}`).join(", ")}</div>}
        {(result.skipped || []).length > 0 && (
          <table className="table"><thead><tr><th>Not signed</th><th>Why</th></tr></thead>
            <tbody>{result.skipped.map((x) => <tr key={x.id}><td><b>{byId[x.id]?.external_ref ? `${byId[x.id].external_ref} · ` : ""}{x.name}</b></td><td style={{ whiteSpace: "normal" }}>{x.reason}</td></tr>)}</tbody></table>
        )}
      </Modal>
    );
  }
  return (
    <Modal open onClose={onClose} title={`Sign off ${tasks.length} task${tasks.length === 1 ? "" : "s"}`} width={680}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="ok" busy={busy} disabled={!s.ready} onClick={submit}>Approve &amp; certify {tasks.length}</Button></>}>
      <p className="note" style={{ margin: 0 }}>Each task gets its own completion certificate with your signature and moves to the next invoice. Open a task to preview its certificate.</p>
      <div className="table-scroll" style={{ maxHeight: 220, border: "1px solid var(--border)", borderRadius: 8 }}>
        <table className="table"><tbody>{tasks.map((t) => (
          <tr key={t.id} className={preview === t.id ? "sel" : ""}>
            <td><span className="ref">{t.external_ref || `#${t.id}`}</span> <b>{t.name}</b><div className="mini">{t.project_name}{t.completion_date ? ` · done ${t.completion_date}` : ""}</div></td>
            <td style={{ textAlign: "right" }}><Button size="sm" kind="ghost" onClick={() => setPreview(preview === t.id ? null : t.id)}>{preview === t.id ? "Hide" : "Preview"}</Button></td>
          </tr>
        ))}</tbody></table>
      </div>
      {preview && <CertificatePreview kpiId={preview} signer={s.name.trim()} sig={s.sig} />}
      <SignatureFields s={s} />
    </Modal>
  );
}
