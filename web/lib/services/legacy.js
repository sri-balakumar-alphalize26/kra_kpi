/* Bugs / updates about a requirement from the OLD database ("From old DB"):
   the rule for what is enough to send, and the KPI Details routes
   (controllers/kpi_legacy_api.py). The rule is the server's own
   (models/kpi_legacy.py legacy_input_problem); the server checks it again. */
import { rpc, read, assertOk } from "@/lib/api";

export const LEGACY_MISSING = "Add a photo or video of the old screen if you can — if not possible, record a voice note or type a message (or add the Request ID).";
export const VOICE_SHORT = "The voice note is too short (5 seconds or more) — add a photo or video if you can, if not possible record again or type a message.";
export const MIC_FAILED = "Can't use the mic — type it instead.";
export const ENOUGH = "✓ Enough to trace this — the team adds anything missing later.";
export const BEST_HINT = "Best: a 📷 photo or 🎥 video of the old screen. If not possible, record a voice note or type a message.";
export const BAD_REF = "The Request ID looks like REQ-012.";
export const PENDING_LABEL = "Pending — confirm with client";

const REF_RE = /^REQ\s*-?\s*(\d{1,9})$/i;
const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();
/* "req 12" → "REQ-012"; anything else is returned as typed. */
export function normalizeRef(v) {
  const m = REF_RE.exec(String(v || "").trim());
  if (!m) return v;
  const n = String(+m[1]);
  return `REQ-${n.padStart(3, "0")}`;
}
/* Seconds from a recorded name, "Voice note 1 (0m07s).webm" → 7; null when the name has none. */
export function voiceSecs(f) {
  const m = /\((\d+)m(\d{1,2})s\)/.exec(f?.name || "");
  return m ? +m[1] * 60 + +m[2] : null;
}
export const isMedia = (f) => /^(image|video)\//.test(f?.type || "") || /\.(jpe?g|png|gif|webp|bmp|heic|heif|mp4|mov|mkv|avi|3gp|m4v)$/i.test(f?.name || "");
export function isAudio(f) {
  if ((f?.type || "").startsWith("video/")) return false;
  return (f?.type || "").startsWith("audio/") || /\.(webm|ogg|opus|mp3|wav|m4a|aac|amr|3gp)$/i.test(f?.name || "");
}
/* '' when the request says enough, else the message to show. Any ONE of: a
   Request ID, a task name (15+ characters or 3+ words), a typed message (30+),
   a photo, a video, a voice note of 5 s or more (no length in the name: an
   audio file of 16 000 bytes or more). files: File objects (or {name, type, size}). */
export function legacyProblem({ ref, name, note, files }) {
  const r = String(ref || "").trim();
  if (r) return REF_RE.test(r) ? "" : BAD_REF;
  const n = squash(name);
  if (n.length >= 15 || n.split(" ").length >= 3) return "";
  if (squash(note).length >= 30) return "";
  const list = files || [];
  if (list.some((f) => f.size && isMedia(f))) return "";
  const audio = list.filter(isAudio);
  if (audio.some((f) => { const s = voiceSecs(f); return s === null ? f.size >= 16000 : s >= 5; })) return "";
  return audio.length ? VOICE_SHORT : LEGACY_MISSING;
}

/* The KPI Details card: {status, legacy: false | {on, status, status_label, ref,
   name, note, transcript, confirmed_by, confirmed_on, parent_id, voice_notes:[{name,url}]}, can_edit}. */
export const getLegacy = (kpiId) => rpc("/kra_kpi/legacy/get", { kpi_id: Number(kpiId) });
/* Admins / managers only. A Request ID links the task under that old
   requirement, renumbers it (BUG-031 → BUG001-REQ-012) and marks it Confirmed.
   Answers {status, legacy, ref, message}; {status:false, message} is left to the caller. */
export const saveLegacy = (kpiId, { ref, name, note }) =>
  rpc("/kra_kpi/legacy/save", { kpi_id: Number(kpiId), ref: String(ref || "").trim(), name: squash(name), note: String(note || "").trim() });
/* Needs linking: From-old-DB tasks still waiting for their Request ID, oldest first. */
export const PENDING_PATH = "/kra_kpi/legacy/pending";
export const fetchLegacyPending = (clientKraId) => read(PENDING_PATH, clientKraId ? { client_kra_id: Number(clientKraId) } : {}, { ttl: 10000 });

export { assertOk };
