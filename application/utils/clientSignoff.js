// Client sign-off helpers — pure, so they are tested without a device
// (utils/__tests__/clientSignoff.test.js). Used by screens/ClientTasks.js and
// components/SignaturePad.js.

// Parse the server's 'YYYY-MM-DD HH:MM:SS' (UTC) into ms. Built explicitly rather
// than via `new Date(str)` — RN/iOS parses that format inconsistently.
export function parseServerTs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s || '');
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

// "2d 5h" / "5h 12m" / "12m" / "under a minute". Days and hours are what a
// 3-day review needs; seconds would only make the card flicker.
export function formatLeft(ms) {
  const min = Math.floor(Math.max(0, ms) / 60000);
  if (min < 1) return 'under a minute';
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "29 Oct, 12:56" in the DEVICE's local time — the time the client lives in.
function localStamp(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${hh}:${mm}`;
}

// The line under an "Awaiting your sign-off" card. The server closes the review
// on its own after kra_kpi.client_review_days with no reply (kpi_finish.py,
// review_due_at), the same rule the WhatsApp sign-off page states.
//
// `dueAt` is review_due_at when the payload carries it; without it we only know
// the rule (`days`, from /kpi_config/finish/get), not when the clock started —
// so we say the rule rather than invent a date. Returns null when neither is
// known, so the card shows nothing instead of a guess.
export function reviewDueText({ dueAt, days, now = Date.now() } = {}) {
  const due = parseServerTs(dueAt);
  if (due) {
    const left = due - now;
    if (left <= 0) return { text: '⏳ Approving automatically…', due: true };
    return { text: `⏳ Auto-approves in ${formatLeft(left)} · ${localStamp(due)}`, due: false };
  }
  const n = Number(days) || 0;
  if (n > 0) {
    return { text: `⏳ No reply within ${n} day${n === 1 ? '' : 's'} of delivery approves it automatically`, due: false };
  }
  return null;
}

// Full Name choices. The server's list of THIS client's people (_client_signers:
// [{ key, name, sig }]) when the payload carries one; otherwise the signed-in
// person, because the route signs as them. 'other' is always offered, for
// someone signing on the client's behalf whose name is not in the list.
export function signerOptions({ signers, userName } = {}) {
  const list = (Array.isArray(signers) ? signers : [])
    .filter((p) => p && p.key && (p.name || '').trim())
    .map((p) => ({ key: String(p.key), name: p.name.trim(), sig: p.sig || '' }));
  if (!list.length && (userName || '').trim()) {
    list.push({ key: 'me', name: userName.trim(), sig: '' });
  }
  return list;
}

// Finger strokes → one SVG path. A stroke is [{ x, y }, ...]; a single tap still
// leaves a dot (a zero-length line with round caps).
export function strokesToPath(strokes) {
  const r = (v) => Math.round(v * 10) / 10;
  return (strokes || [])
    .filter((st) => st && st.length)
    .map((st) => {
      const [p0, ...rest] = st;
      const head = `M${r(p0.x)} ${r(p0.y)}`;
      if (!rest.length) return `${head} l0.1 0`;
      return head + rest.map((p) => ` L${r(p.x)} ${r(p.y)}`).join('');
    })
    .join(' ');
}

// Font size for the Auto signature: the largest that fits the box, the same
// shrink-to-fit the sign-off page does on its canvas. A cursive glyph averages
// roughly half its size in width.
export function autoFontSize(name, width, height) {
  const len = Math.max(1, (name || '').trim().length);
  const byWidth = (Math.max(0, width - 30)) / (len * 0.5);
  return Math.max(14, Math.min(height * 0.6, byWidth));
}

// The Sign & Approve gate: the three ticks, a name, and a signature — a saved
// one, the typed name drawn (Auto), or something drawn by hand.
export function signoffReady({ ticks, name, mode, inked }) {
  const t = ticks || {};
  if (!(t.delivered && t.works && t.authorized)) return false;
  if (!(name || '').trim()) return false;
  if (mode === 'saved' || mode === 'auto') return true;
  return mode === 'draw' && !!inked;
}
