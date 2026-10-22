"use client";
/* 🎤 Voice note, WhatsApp style (port of setupVoice in the WhatsApp client
   form, static/src/wa_client_form/form.js): Record → ⏸ Pause to listen to
   everything so far → ▶ Resume to add more → ➤ Attach (or 🗑 to throw it
   away). Nothing reaches the file list until Attach. The file is named
   "Voice note 1 (0m07s).webm": the server reads the length from the name.
   No microphone (or not allowed): onMicFailed, so the caller can point to
   the message box instead. */
import { useEffect, useRef, useState } from "react";
import { Button, Modal } from "@/components/ui";

const VOICE_MAX_MS = 5 * 60 * 1000;
const fmt = (t) => { const s = Math.floor(t / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

export default function VoiceRecorder({ onAttach, onMicFailed, kind = "ghost", size, label = "🎤 Voice note" }) {
  const [supported, setSupported] = useState(true);
  const [mode, setMode] = useState(null); /* null | 'starting' | 'recording' | 'paused' | 'done' (hit the 5-minute cap) */
  const [shown, setShown] = useState(0);
  const [preview, setPreview] = useState("");
  const r = useRef({ rec: null, stream: null, chunks: [], mime: "", elapsed: 0, runFrom: 0, tick: null, cap: null, count: 0, attachAfter: false, wantPreview: false, url: "" });
  /* Feature check after mount: the server render has no navigator. */
  useEffect(() => { setSupported(!!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder)); }, []);
  useEffect(() => () => { cleanup(); dropPreview(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const ms = () => { const s = r.current; return s.elapsed + (s.rec?.state === "recording" ? Date.now() - s.runFrom : 0); };
  function cleanup() {
    const s = r.current;
    if (s.stream) { s.stream.getTracks().forEach((t) => t.stop()); s.stream = null; }
    clearInterval(s.tick); clearTimeout(s.cap);
  }
  function dropPreview() {
    const s = r.current;
    if (s.url) { URL.revokeObjectURL(s.url); s.url = ""; }
    setPreview("");
  }
  /* Everything recorded so far, playable while paused. */
  function buildPreview() {
    const s = r.current;
    dropPreview();
    if (!s.chunks.length) return;
    s.url = URL.createObjectURL(new Blob(s.chunks, { type: s.mime }));
    setPreview(s.url);
  }
  function attach() {
    const s = r.current;
    const ext = s.mime.includes("mp4") ? "m4a" : s.mime.includes("ogg") ? "ogg" : "webm";
    s.count += 1;
    const file = new File([new Blob(s.chunks, { type: s.mime })], `Voice note ${s.count} (${fmt(s.elapsed).replace(":", "m")}s).${ext}`, { type: s.mime });
    dropPreview();
    s.rec = null; s.chunks = [];
    setMode(null);
    onAttach?.(file);
  }
  function finished() {
    const s = r.current;
    cleanup();
    setShown(s.elapsed);
    if (!s.chunks.length) { setMode(null); return; }
    if (s.attachAfter) { attach(); return; }
    setMode("done");
    buildPreview();
  }
  function stopRec() {
    const s = r.current;
    if (!s.rec || s.rec.state === "inactive") return;
    /* Bank the running stretch BEFORE stopping: once stopped, ms() no longer counts it. */
    if (s.rec.state === "recording") s.elapsed += Date.now() - s.runFrom;
    s.rec.stop();
  }
  function start() {
    const s = r.current;
    dropPreview();
    Object.assign(s, { chunks: [], elapsed: 0, attachAfter: false, wantPreview: false, rec: null });
    setShown(0); setMode("starting");
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      s.stream = stream;
      const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported?.(t));
      const rec = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
      s.rec = rec;
      s.mime = (rec.mimeType || type || "audio/webm").split(";")[0];
      rec.ondataavailable = (e) => {
        if (e.data?.size) s.chunks.push(e.data);
        if (s.wantPreview && rec.state === "paused") { s.wantPreview = false; buildPreview(); }
      };
      rec.onstop = finished;
      rec.start(250);
      s.runFrom = Date.now();
      setMode("recording");
      s.tick = setInterval(() => setShown(ms()), 250);
      s.cap = setTimeout(stopRec, VOICE_MAX_MS);
    }).catch(() => {
      cleanup();
      setMode(null);
      onMicFailed?.();
    });
  }
  function togglePause() {
    const s = r.current;
    if (!s.rec) return;
    if (s.rec.state === "recording") {
      s.rec.pause();
      s.elapsed += Date.now() - s.runFrom;
      setShown(s.elapsed); setMode("paused");
      /* Flush what is buffered so the preview has every second up to now. */
      s.wantPreview = true;
      try { s.rec.requestData(); } catch { s.wantPreview = false; buildPreview(); }
    } else if (s.rec.state === "paused") {
      s.rec.resume();
      s.runFrom = Date.now();
      dropPreview(); setMode("recording");
    }
  }
  function discard() {
    const s = r.current;
    if (s.rec && s.rec.state !== "inactive") { s.rec.onstop = null; s.rec.stop(); }
    cleanup(); dropPreview();
    s.rec = null; s.chunks = [];
    setMode(null);
  }
  function send() {
    const s = r.current;
    if (s.rec && s.rec.state !== "inactive") { s.attachAfter = true; stopRec(); return; }
    if (s.chunks.length) attach();
  }

  const canPause = typeof r.current.rec?.pause === "function";
  return (
    <>
      <Button type="button" kind={kind} size={size} onClick={() => (supported ? start() : onMicFailed?.())} title={supported ? "Record a voice note" : "Voice recording is not available in this browser"}>{supported ? label : "🎤 Can't record here — type it below"}</Button>
      <Modal open={!!mode} onClose={discard} title="🎤 Voice note" width={420}
        footer={<><Button kind="ghost" onClick={discard}>🗑 Delete</Button>
          {(mode === "recording" || mode === "paused") && canPause && <Button onClick={togglePause}>{mode === "paused" ? "▶ Resume" : "⏸ Pause"}</Button>}
          <Button kind="primary" disabled={mode === "starting"} onClick={send}>➤ Attach</Button></>}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
          <b style={{ fontSize: 28, color: mode === "recording" ? "var(--danger)" : "var(--navy)", fontVariantNumeric: "tabular-nums" }}>{mode === "recording" ? "● " : ""}{fmt(shown)}</b>
          <span className="mini">{mode === "starting" ? "Allow the microphone…" : mode === "recording" ? "Recording… pause to listen to it" : mode === "paused" ? "Paused — listen below, resume to record more, or attach" : "That is the 5-minute limit — listen, then attach"}</span>
          {preview && <audio controls src={preview} style={{ width: "100%" }} />}
        </div>
      </Modal>
    </>
  );
}
