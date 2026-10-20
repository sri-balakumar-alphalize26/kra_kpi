"use client";
/* Settings › AI & Transcription — Odoo's kpi.ai.config, a settings form over
   ir.config_parameter (a TransientModel). Same as Odoo's screen: a fresh
   record is created to show the current values and the two status panels;
   Save writes and calls action_save; the Test buttons call action_test_* on
   the record as it stands (save first so a test uses what is on screen). */
import { useCallback, useEffect, useState } from "react";
import { Button, ErrorState, PageHeader, Skeleton, useFlags } from "@/components/ui";
import { callKw } from "@/lib/api";
import { notice } from "@/lib/services/sysadmin";
import { FieldInput } from "./RecordScreen";
import SettingsNav from "./SettingsNav";

const M = "kpi.ai.config";
const FORM = [
  { section: "Status" }, "status_html",
  { section: "Meeting server (8x8 / Jitsi)" }, "meet_server_html", "meet_base_url", "jaas_app_id", "jaas_api_key_id", "jaas_private_key",
  { section: "Custom AI endpoint (OpenAI-compatible, tried first)" }, "custom_api_url", "custom_api_key", "custom_model",
  { section: "Providers" }, "gemini_api_key", "gemini_model", "groq_api_key", "groq_model", "anthropic_api_key", "anthropic_model",
  { section: "Speech to text" }, "transcribe_provider", "whisper_model", "openai_api_key",
  { section: "Meeting recording" }, "segment_minutes", "record_keep_days", "bot_alone_seconds", "idle_seconds", "auto_summary", "auto_post_summary",
];
const SECRET = ["jaas_private_key", "custom_api_key", "gemini_api_key", "groq_api_key", "anthropic_api_key", "openai_api_key"];
const TESTS = [["action_test_summary", "Test Summaries"], ["action_test_meeting_server", "Test Meeting Server"], ["action_test_transcribe", "Test Speech To Text"]];
const names = FORM.filter((f) => typeof f === "string");

export default function AiConfig() {
  const flags = useFlags();
  const [meta, setMeta] = useState(null);
  const [rec, setRec] = useState(null);
  const [orig, setOrig] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const m = await callKw(M, "fields_get", [], { attributes: ["string", "type", "required", "readonly", "selection", "help"] });
      const id = await callKw(M, "create", [[{}]]);
      const [r] = await callKw(M, "read", [[Array.isArray(id) ? id[0] : id], names]);
      setMeta(m); setRec(r); setOrig(r); setErr(null);
    } catch (e) { setErr(e); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const changes = () => {
    const v = {};
    for (const f of names) {
      if (!meta[f] || meta[f].readonly) continue;
      let x = rec[f];
      if (meta[f].type === "integer") x = parseInt(x, 10) || 0;
      if (x !== orig[f]) v[f] = x === "" ? false : x;
    }
    return v;
  };
  const call = async (method, label) => {
    setBusy(method);
    try {
      const v = changes();
      if (Object.keys(v).length) await callKw(M, "write", [[rec.id], v]);
      const r = await callKw(M, method, [[rec.id]]);
      flags.ok(notice(r) || `${label}: done.`);
      if (method === "action_save") await load();
      else { const [fresh] = await callKw(M, "read", [[rec.id], names]); setRec(fresh); setOrig(fresh); }
    } catch (e) { flags.err(e.message); } finally { setBusy(""); }
  };
  const show = (f, v) => (v === false || v == null ? "" : meta?.[f]?.type === "selection" ? (meta[f].selection || []).find(([k]) => k === v)?.[1] || v : String(v));

  return (
    <>
      <PageHeader crumbs={[{ label: "Settings" }, { label: "AI & Transcription" }]} title="AI & Transcription" meta="AI keys and models, speech to text, meeting recording and the meeting server">
        {rec && TESTS.map(([m, l]) => <Button key={m} busy={busy === m} onClick={() => call(m, l)}>{l}</Button>)}
        {rec && <Button kind="primary" busy={busy === "action_save"} onClick={() => call("action_save", "Save")}>Save</Button>}
      </PageHeader>
      <SettingsNav />
      <div className="page">
        {err && <ErrorState error={err} onRetry={load} />}
        {!rec && !err && <div className="cardbox"><Skeleton rows={8} /></div>}
        {rec && meta && (
          <div className="cardbox">
            <div className="rs-form">
              {FORM.map((f, i) => typeof f === "string"
                ? meta[f] && <FieldInput key={f} name={f} m={meta[f]} value={rec[f]} readOnly={!!meta[f].readonly} secret={SECRET.includes(f)} show={show} onChange={(v) => setRec((r) => ({ ...r, [f]: v }))} />
                : <h3 key={`s${i}`} className="rs-section">{f.section}</h3>)}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
