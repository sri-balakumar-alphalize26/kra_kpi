"use client";
import { useEffect, useState } from "react";
import { Button, Field, Icon, Input, PageHeader, useFlags, Select } from "@/components/ui";
import * as A from "@/lib/services/admin";
import IntakeNav from "./IntakeNav";

/* Generate client files: a ZIP with Requirements / Updates / Bugs XLSX for a
   client (type='http' route, so it is a plain download link through the proxy). */
export default function ClientFiles() {
  const flags = useFlags();
  const [clients, setClients] = useState([]); const [client, setClient] = useState("");
  const [kras, setKras] = useState([]); const [kra, setKra] = useState("");
  const [version, setVersion] = useState("v1.0");
  const [include, setInclude] = useState(true);
  useEffect(() => { A.getClients().then(setClients).catch((e) => flags.err(e.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!client) { setKras([]); setKra(""); return; } A.getSubKras(+client).then((k) => { setKras(k); setKra(""); }).catch(() => setKras([])); }, [client]);
  const url = client ? A.clientZipHref({ client_kra_id: client, project_kra_id: kra, version, include_data: include ? "1" : "0" }) : null;
  const who = clients.find((c) => String(c.id) === client);

  return (
    <>
      <PageHeader crumbs={[{ label: "Work" }, { label: "Client files" }]} title="Generate client files" meta="A ZIP with one XLSX per type, pre-filled for the client" />
      <IntakeNav />
      <div className="g12" style={{ flex: 1, minHeight: 0 }}>
        <div className="cardbox"><h2>What to generate</h2>
          <Field label="Client"><span className="input"><Select value={client} onChange={(e) => setClient(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}><option value="">Choose a client</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></span></Field>
          <div className="grid2">
            <Field label="Project (optional)"><span className="input"><Select value={kra} onChange={(e) => setKra(e.target.value)} disabled={!kras.length} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}><option value="">All projects</option>{kras.map((k) => <option key={k.id} value={k.id}>{k.display || k.name}</option>)}</Select></span></Field>
            <Field label="Version label"><Input value={version} onChange={(e) => setVersion(e.target.value)} /></Field>
          </div>
          <div className="kv"><span className="lbl">Include existing tasks</span><span className="val">Pre-fill rows from the client's open tasks</span><span className="right"><span className={`toggle ${include ? "on" : ""}`} role="switch" aria-checked={include} onClick={() => setInclude((v) => !v)} style={{ cursor: "pointer" }} /></span></div>
          <div className="kv" style={{ border: 0 }}><span className="lbl">Files in the ZIP</span><span className="pillset">{["Requirements.xlsx", "Updates.xlsx", "Bugs.xlsx"].map((f) => <span key={f} className="chip-sm" style={{ background: "var(--hover)", color: "var(--navy)" }}>{f}</span>)}</span></div>
          {url ? <a className="btn btn-primary bigbtn" style={{ alignSelf: "flex-start", padding: "0 22px", textDecoration: "none" }} href={url}><Icon n="download" size={18} />Download ZIP{who ? ` · ${who.name}` : ""}</a> : <Button kind="primary" size="lg" disabled>Download ZIP</Button>}
        </div>
        <div className="cardbox"><h2>How it is used</h2>
          <div className="steps" style={{ flexDirection: "column", alignItems: "flex-start", gap: 10 }}><span className="on"><b>1</b>Send the ZIP to the client</span><span><b>2</b>They fill one row per request in the right sheet</span><span><b>3</b>Upload the sheet in Upload requirements → tasks are created in bulk</span></div>
          <p className="mini" style={{ margin: 0 }}>Blank templates: <a href={A.templateHref("requirement")}>requirement</a> · <a href={A.templateHref("update")}>update</a> · <a href={A.templateHref("bug")}>bug report</a></p>
        </div>
      </div>
    </>
  );
}
