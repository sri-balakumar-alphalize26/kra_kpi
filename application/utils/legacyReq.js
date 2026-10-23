// "From old DB" bugs / updates: the new database has none of the old
// requirements, so a client can tick "It's from the old system" instead of
// picking one — and then has to say what it is about.
//
// Pure and separate from the screen because the RULE and the WORDING are the
// contract: this is legacy_input_problem() in models/kpi_legacy.py, the same
// rule the WhatsApp form runs (static/src/wa_client_form/form.js, oldProblem).
// Any ONE of these is enough: a voice note of 5 s or more, a typed message of
// 30+ characters, a photo, a video, a valid Request ID, or a task name of 15+
// characters or 3+ words. A port that softens one of them lets the app send what
// the server then refuses.

export const LEGACY_NOTE_MIN = 30;        // typed message: "ok" / "same issue" do not count
export const LEGACY_NAME_MIN = 15;        // task name: 15 characters …
export const LEGACY_NAME_MIN_WORDS = 3;   // … or 3 words
export const VOICE_MIN_SECONDS = 5;
// A voice note whose name carries no "(XmYYs)" length counts by its size.
export const VOICE_MIN_BYTES = 16000;

export const LEGACY_MISSING_MSG = 'Add a photo or video of the old screen if you can — if not possible, record a voice note or type a message (or add the Request ID).';
export const VOICE_SHORT_MSG = 'The voice note is too short (5 seconds or more) — add a photo or video if you can, if not possible record again or type a message.';
export const REF_BAD_MSG = 'The Request ID looks like REQ-012.';
export const MIC_FAILED_MSG = "Can't use the mic — type it instead.";
export const LEGACY_OK_MSG = '✓ Enough to trace this — the team adds anything missing later.';
export const LEGACY_BEST_HINT = 'Best: a 📷 photo or 🎥 video of the old screen. If not possible, record a voice note or type a message.';

const REF_RE = /^REQ\s*-?\s*(\d{1,9})$/i;
const VOICE_LEN_RE = /\((\d+)m(\d{1,2})s\)/;
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i;
const VIDEO_EXT_RE = /\.(mp4|mov|mkv|avi|3gp|m4v)$/i;
const AUDIO_EXT_RE = /\.(webm|ogg|opus|mp3|wav|m4a|aac|amr|3gp)$/i;

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// 'req 12' / 'REQ-12' / 'REQ-012' -> 'REQ-012'. '' when empty, null when it is
// not a REQ number at all.
export function normalizeLegacyRef(ref) {
  const s = String(ref || '').trim();
  if (!s) return '';
  const m = REF_RE.exec(s);
  if (!m) return null;
  return `REQ-${String(parseInt(m[1], 10)).padStart(3, '0')}`;
}

// The length the recorder writes into the name: "Voice note 1 (0m07s).m4a" -> 7.
export function voiceSeconds(name) {
  const m = VOICE_LEN_RE.exec(name || '');
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

// "Voice note 2 (1m05s).m4a" — the name the server reads the length back from.
export function voiceNoteName(count, millis, ext = 'm4a') {
  const secs = Math.max(0, Math.round((Number(millis) || 0) / 1000));
  const mm = Math.floor(secs / 60);
  const ss = String(secs % 60).padStart(2, '0');
  return `Voice note ${count} (${mm}m${ss}s).${String(ext || 'm4a').replace(/^\./, '')}`;
}

export function isImageOrVideo(name, mimetype = '') {
  const m = String(mimetype || '').toLowerCase();
  if (m.startsWith('image/') || m.startsWith('video/')) return true;
  return IMAGE_EXT_RE.test(name || '') || VIDEO_EXT_RE.test(name || '');
}

export function isAudio(name, mimetype = '') {
  const m = String(mimetype || '').toLowerCase();
  if (m.startsWith('video/')) return false;
  return m.startsWith('audio/') || AUDIO_EXT_RE.test(name || '');
}

export function isUsableVoice(name, size, mimetype = '') {
  if (!isAudio(name, mimetype)) return false;
  const secs = voiceSeconds(name);
  if (secs !== null) return secs >= VOICE_MIN_SECONDS;
  return (Number(size) || 0) >= VOICE_MIN_BYTES;
}

// '' when the From-old-DB request says enough, else the message to show.
// files: [{ name, size, mimetype }] — what is being attached with it.
export function legacyProblem({ ref, name, note, files } = {}) {
  if (String(ref || '').trim()) return normalizeLegacyRef(ref) ? '' : REF_BAD_MSG;
  const n = squash(name);
  if (n.length >= LEGACY_NAME_MIN || (n && n.split(' ').length >= LEGACY_NAME_MIN_WORDS)) return '';
  if (squash(note).length >= LEGACY_NOTE_MIN) return '';
  const rows = (files || []).filter(Boolean);
  // A photo or a video of the old screen says what it is about by itself.
  if (rows.some((f) => f.size && isImageOrVideo(f.name, f.mimetype))) return '';
  const audio = rows.filter((f) => isAudio(f.name, f.mimetype));
  if (audio.some((f) => isUsableVoice(f.name, f.size, f.mimetype))) return '';
  return audio.length ? VOICE_SHORT_MSG : LEGACY_MISSING_MSG;
}

// The live hint under the box: { text, ok } — red while something is missing.
export function legacyHint(input) {
  const p = legacyProblem(input);
  return p ? { text: p, ok: false } : { text: LEGACY_OK_MSG, ok: true };
}

// The task-list badge: "🗄️ Old DB" (+ "Pending" until confirmed with the client).
export function legacyBadge(row) {
  if (!row || !row.legacy_req_link) return null;
  return { label: '🗄️ Old DB', pending: row.legacy_status === 'pending' };
}
