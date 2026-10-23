// The URLs the home-screen widgets open the app with, parsed.
//
//   krakpi://widget/actionboard                      tap on the task widget's body
//   krakpi://widget/home?action=pause&kpi=42         the widget's Pause button
//   krakpi://widget/home?action=resume&kpi=42        the widget's Resume button
//   krakpi://widget/livetracking                     tap on the Live Tracking card
//   krakpi://widget/livetracking?user=7              tap on one person's row
//
// The URL arrives from OUTSIDE the JS — an Android PendingIntent, and in
// principle any app holding the scheme — so it is treated as untrusted input:
// only the destinations the widgets actually offer, only the two actions, and
// only positive integer ids get through. Anything else is null, and the caller
// does nothing. Treating the path as a free-form screen name would let a
// stranger open arbitrary screens.
//
// Query parsing is by hand: React Native's URL and URLSearchParams are partial
// implementations, and a link this small does not need them. Pure — no React
// Native imports — so it unit-tests without a device.

const DESTS = new Set(['actionboard', 'livetracking', 'home']);
const ACTIONS = new Set(['pause', 'resume']);

// A record id: digits only, sane length, greater than zero. "0", "-1", "1e3" and
// "42abc" are all refused rather than coerced.
function positiveInt(s) {
  if (typeof s !== 'string' || !/^\d{1,12}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

function decode(s) {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (_) { return s; }
}

// First occurrence wins, so "?kpi=1&kpi=2" cannot smuggle a second id past a
// caller that only reads one.
function parseQuery(q) {
  const out = {};
  for (const part of (q || '').split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = decode(eq < 0 ? part : part.slice(0, eq));
    const v = eq < 0 ? '' : decode(part.slice(eq + 1));
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/**
 * @param {string} url
 * @returns {{dest: string, action: string|null, kpiId: number|null, userId: number|null} | null}
 *   null when the URL is not a widget link at all, or names a destination the
 *   widgets do not offer.
 */
export function parseWidgetLink(url) {
  if (typeof url !== 'string') return null;
  const m = /^krakpi:\/\/widget\/([a-z]+)\/?(?:\?([^#]*))?(?:#.*)?$/i.exec(url.trim());
  if (!m) return null;
  const dest = m[1].toLowerCase();
  if (!DESTS.has(dest)) return null;

  const q = parseQuery(m[2]);
  const rawAction = String(q.action || '').toLowerCase();
  return {
    dest,
    action: ACTIONS.has(rawAction) ? rawAction : null,
    kpiId: positiveInt(q.kpi),
    userId: positiveInt(q.user),
  };
}
