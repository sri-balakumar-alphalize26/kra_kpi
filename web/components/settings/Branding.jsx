"use client";
import { useEffect, useState } from "react";
import { Button, Field, Icon, Input, PageHeader, Skeleton, useFlags } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import { invalidate } from "@/lib/api";
import * as S from "@/lib/services/settings";
import SettingsNav from "./SettingsNav";

/* Company name + logo (res.company), shown in the header, on PDFs and in messages. */
export default function Branding() {
  const flags = useFlags();
  const brand = useResource(S.BRAND_PATH, {}, { ttl: 10000 });
  const [name, setName] = useState(""); const [logo, setLogo] = useState(null); /* b64 */
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (brand.data) { setName(brand.data.name || ""); setLogo(brand.data.logo_b64 || null); } }, [brand.data]);
  const pick = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const img = new Image(); const url = URL.createObjectURL(f);
    img.onload = () => { const c = document.createElement("canvas"); const s = Math.min(512, Math.max(img.width, img.height)); c.width = c.height = s; const ctx = c.getContext("2d"); const r = Math.min(s / img.width, s / img.height); const w = img.width * r, h = img.height * r; ctx.drawImage(img, (s - w) / 2, (s - h) / 2, w, h); setLogo(c.toDataURL("image/png").split(",")[1]); URL.revokeObjectURL(url); };
    img.src = url; e.target.value = "";
  };
  const save = async (e) => { e.preventDefault(); setBusy(true); try { S.assertOk(await S.saveBranding({ name: name.trim(), logo_b64: logo || "" }), "Could not save."); flags.ok("Branding saved."); invalidate("/kra_kpi/company"); brand.refresh(); } catch (ex) { flags.err(ex.message); } finally { setBusy(false); } };
  const src = logo ? `data:image/png;base64,${logo}` : null;

  return (
    <>
      <PageHeader crumbs={[{ label: "Settings" }, { label: "Company branding" }]} title="Company branding" meta="Shown in the app and web headers, on PDFs and in client messages" />
      <SettingsNav />
      <div className="g12" style={{ flex: 1, minHeight: 0 }}>
        <form className="cardbox" onSubmit={save}>
          <h2>Company</h2>
          {!brand.data ? <Skeleton rows={3} /> : (
            <>
              <Field label="Company name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Logo"><label className="dropzone" style={{ display: "flex", alignItems: "center", gap: 14, textAlign: "left", cursor: "pointer" }}>{src ? <img src={src} alt="" style={{ width: 56, height: 56, borderRadius: 14, objectFit: "contain", background: "#fff" }} /> : <span className="logo-big" style={{ width: 56, height: 56, borderRadius: 14, fontSize: 16 }}>369</span>}<span><b>{src ? "Click to replace" : "Choose a PNG or JPG"}</b>Square, transparent background works best. Resized to 512 px.</span><input type="file" accept="image/*" hidden onChange={pick} /></label></Field>
              <div className="row"><Button type="submit" kind="primary" busy={busy}>Save</Button>{src && <Button type="button" kind="ghost" onClick={() => setLogo(null)}>Remove logo</Button>}</div>
            </>
          )}
        </form>
        <div className="cardbox"><h2>Preview</h2>
          <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
            <div className="top" style={{ height: 52, position: "static" }}><div className="logo">{src ? <img src={src} alt="" style={{ width: 28, height: 28, borderRadius: 9, objectFit: "cover" }} /> : <span className="logo-tile">369</span>}{name || "KRA KPI"}</div><span className="nav-btn on">Your work</span><span className="nav-btn">Projects</span><span className="avatar" style={{ marginLeft: "auto", background: "#6554C0" }}>AK</span></div>
            <div style={{ padding: 16, display: "flex", gap: 14, background: "var(--canvas)", flexWrap: "wrap" }}>
              <div style={{ width: 220, aspectRatio: "1/1.3", background: "#fff", boxShadow: "var(--shadow-lg)", borderRadius: 4, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>{src ? <img src={src} alt="" style={{ width: 22, height: 22 }} /> : <span className="logo-tile" style={{ width: 22, height: 22, fontSize: 8 }}>369</span>}<span className="mini">INV/2026/0047</span></div><b style={{ fontSize: 12, color: "var(--navy)" }}>{name || "Company"}</b><span style={{ height: 5, width: "70%", background: "var(--paper-line)", borderRadius: 3 }} /><span style={{ height: 5, width: "90%", background: "var(--paper-line)", borderRadius: 3 }} /><span style={{ height: 50, background: "var(--tint-blue-bg)", borderRadius: 6, marginTop: 6 }} /><span className="mini" style={{ marginTop: "auto" }}>PDF header</span></div>
              <div style={{ flex: 1, minWidth: 220, display: "flex", flexDirection: "column", gap: 10 }}><div className="wa-bubble" style={{ fontSize: 12.5, lineHeight: "18px" }}><b style={{ color: "var(--wa-text)" }}>{name || "Company"} · KRA KPI</b><br />Hi Raj, REQ-007 "Table merge for large groups" is ready for your sign-off.</div><span className="mini">WhatsApp messages carry the company name.</span></div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
