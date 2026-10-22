// The task's Client tab: every time the client sent this request, oldest first
// (/kra_kpi/client_sends → models/kpi_legacy.py client_sends()).
//
// Pure and separate from the screen so the labels can be tested without a
// device. Dates are passed in already formatted (`when`), so nothing here
// depends on the phone's timezone.

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i;
const VIDEO_EXT_RE = /\.(mp4|mov|mkv|avi|3gp|m4v|webm)$/i;
const AUDIO_EXT_RE = /\.(ogg|opus|mp3|wav|m4a|aac|amr)$/i;
// "Voice note 1 (0m12s).webm" is a recording, not a video.
const VOICE_NAME_RE = /voice|\(\d+m\d{1,2}s\)/i;

const trimmed = (s) => String(s || '').trim();

// 1 → '1st', 2 → '2nd', 11 → '11th', 22 → '22nd'.
export function ordinal(n) {
  const v = Math.abs(Number(n) || 0);
  const teen = v % 100;
  if (teen >= 11 && teen <= 13) return `${v}th`;
  return `${v}${({ 1: 'st', 2: 'nd', 3: 'rd' })[v % 10] || 'th'}`;
}

// 1 → '①' … 20 → '⑳'; past that, '21.'.
export function circled(n) {
  const v = Number(n) || 0;
  return v >= 1 && v <= CIRCLED.length ? CIRCLED[v - 1] : `${v}.`;
}

// "① 1st send · 22 Oct, 10:15 · by Ravi".
export function sendHeading(send, when = (s) => s || '') {
  const n = send?.round || 1;
  const parts = [`${circled(n)} ${ordinal(n)} send`];
  const at = when(send?.sent_at);
  if (at) parts.push(at);
  if (trimmed(send?.sent_by)) parts.push(`by ${trimmed(send.sent_by)}`);
  return parts.join(' · ');
}

// The decision line under a send: { icon, text, reason }.
export function sendStatus(send, when = (s) => s || '') {
  const by = trimmed(send?.refused_by);
  switch (send?.status) {
    case 'refused': {
      const at = when(send.refused_at);
      return {
        icon: '❌',
        text: `Refused${by ? ` by ${by}` : ''}${at ? ` · ${at}` : ''}`,
        reason: trimmed(send.reason),
      };
    }
    case 'retyped':
      return { icon: '🔁', text: `Re-typed${by ? ` by ${by}` : ''}`, reason: trimmed(send.reason) };
    case 'replaced':
      return { icon: '🔁', text: 'Replaced by a newer send', reason: '' };
    case 'accepted':
      return { icon: '✅', text: 'Accepted', reason: '' };
    default:
      return { icon: '⏳', text: 'Waiting for decision', reason: '' };
  }
}

// 📷 photo · 🎥 video · 🎤 voice / audio · 📎 anything else.
export function fileIcon(name) {
  const n = String(name || '');
  if (IMAGE_EXT_RE.test(n)) return '📷';
  if (AUDIO_EXT_RE.test(n) || (VOICE_NAME_RE.test(n) && /\.(webm|3gp)$/i.test(n))) return '🎤';
  if (VIDEO_EXT_RE.test(n)) return '🎥';
  return '📎';
}

// Where a send's file lives, as ids for /kpi/progress/file_b64: an extra file by
// its attachment id, an entry's own first file by its progress id. Falls back to
// reading the ids out of the web url (same idea as legacyVoiceSource).
export function sendFileSource(f) {
  if (f?.att) return { progressId: 0, attachmentId: Number(f.att) };
  if (f?.entry) return { progressId: Number(f.entry), attachmentId: 0 };
  const att = /[?&]attachment_id=(\d+)/.exec(f?.url || '');
  if (att) return { progressId: 0, attachmentId: Number(att[1]) };
  const prog = /[?&]progress_id=(\d+)/.exec(f?.url || '');
  if (prog) return { progressId: Number(prog[1]), attachmentId: 0 };
  return null;
}

// Is there anything the client actually sent? A send counts when it carries
// files, or a description the client wrote (a sender is named — a task the team
// raised itself has none). Two or more sends always count: the client sent again.
export function hasClientSends(sends) {
  const list = Array.isArray(sends) ? sends : [];
  if (list.length > 1) return true;
  return list.some((s) => (s.files || []).length > 0 || (trimmed(s.sent_by) && trimmed(s.description)));
}
