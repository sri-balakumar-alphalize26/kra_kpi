// MEETINGS — Odoo's kpi.meeting (asked for on WhatsApp), mobile port of the web's
// My Work › Meetings (web/lib/services/meetings.js). Like the web there are no
// custom list routes: plain ORM calls through /web/dataset/call_kw, so Odoo's own
// ACLs decide who sees what (admins / owners / System everything; developers
// read). The one custom route is /kpi_meeting/my_link — the room for the
// SIGNED-IN user, named from Odoo, so nobody types a name in the room.
//
// Read-only on purpose: Confirm & send link / Open now / Finished / Send summary /
// Cancel each post to the client's WhatsApp group, and stay on the web.
import { Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { getConnection } from '../api/session';
import { jsonRpc, normalizeUrl } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('Meetings');
const LONG = 45000;

async function server() {
  const { serverUrl } = await getConnection();
  return serverUrl || '';
}

// call_kw through jsonRpc (not odooApi.callKw): the longer window, and a dead
// session is reported the same way every other screen's is.
async function kw(model, method, args = [], kwargs = {}) {
  const base = await server();
  return jsonRpc(base, '/web/dataset/call_kw', { model, method, args, kwargs }, LONG);
}

// state → [tone, label]. Tones map to the screen's chip colours.
export const STATES = {
  requested: ['paused', 'Waiting to confirm'],
  confirmed: ['review', 'Confirmed'],
  live: ['progress', 'Open now'],
  done: ['done', 'Finished'],
  cancelled: ['neutral', 'Cancelled'],
};

// The Odoo search filters, in the same order as the web tabs.
export const FILTERS = [
  { key: 'requested', label: 'Waiting', domain: [['state', '=', 'requested']] },
  { key: 'confirmed', label: 'Confirmed', domain: [['state', '=', 'confirmed']] },
  { key: 'live', label: 'Open now', domain: [['state', '=', 'live']] },
  { key: 'done', label: 'Finished', domain: [['state', '=', 'done']] },
  { key: 'all', label: 'All', domain: [] },
];

const LIST_FIELDS = ['name', 'kpi_id', 'client_kra_id', 'scheduled_start', 'duration_minutes',
  'local_when', 'requested_text', 'organizer_id', 'requested_by_name', 'state', 'actual_minutes',
  'participant_summary', 'is_internal'];
// The detail sheet. Deliberately NOT the recording fields: record_meeting carries
// groups="group_kra_admin", and asking for it as a developer fails the whole read.
const DETAIL_FIELDS = [...LIST_FIELDS, 'attendee_user_ids', 'provider', 'join_url',
  'confirmed_by_id', 'confirmed_at', 'opened_at', 'ended_at', 'cancel_reason',
  'summary', 'action_items', 'summary_posted', 'notes'];

// Odoo many2one [id, "Name"] → "Name".
export const m2o = (v) => (Array.isArray(v) ? v[1] || '' : '');

// Odoo datetimes are UTC 'YYYY-MM-DD HH:MM:SS' → "Mon 27 Oct, 3:30 pm" on the phone.
export function localWhen(ts) {
  if (!ts) return '';
  const d = new Date(String(ts).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return String(ts);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let h = d.getHours();
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${days[d.getDay()]} ${String(d.getDate()).padStart(2, '0')} ${months[d.getMonth()]}, `
    + `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ap}`;
}

// → { isMock, rows } — newest first, up to `limit`.
export async function listMeetings(domain, limit = 200) {
  const base = await server();
  if (!base) return { isMock: true, rows: [] };
  log.info('listMeetings → kpi.meeting.search_read', { domain });
  const rows = await kw('kpi.meeting', 'search_read', [domain || []],
    { fields: LIST_FIELDS, limit, order: 'scheduled_start desc, id desc' });
  return { isMock: false, rows: rows || [] };
}

// → { requested: n, confirmed: n, … } for the tab badges. One failed count
// leaves that badge empty rather than failing the screen.
export async function countMeetings(domainFor) {
  const base = await server();
  if (!base) return {};
  const n = await Promise.all(FILTERS.map((f) =>
    kw('kpi.meeting', 'search_count', [domainFor(f.key)]).catch(() => 0)));
  return Object.fromEntries(FILTERS.map((f, i) => [f.key, n[i] || 0]));
}

export async function readMeeting(id) {
  const base = await server();
  if (!base) return null;
  const r = await kw('kpi.meeting', 'read', [[id], DETAIL_FIELDS]);
  return (r && r[0]) || null;
}

// Who was in the room: [{ name, user, minutes, removed, absent }]. The model's
// own read-only method (check_access('read') inside). Never throws.
export async function attendance(id) {
  try {
    const r = await kw('kpi.meeting', 'attendance_sheet', [[id]]);
    return Array.isArray(r) ? r : [];
  } catch (e) {
    log.warn('attendance', e?.message);
    return [];
  }
}

// The room for ME → url. The server names me from my Odoo user and refuses
// (with a sentence) a cancelled meeting, one I'm not invited to, or one with no
// room yet — thrown so the screen can show it.
export async function myLink(meetingId) {
  const base = await server();
  if (!base) throw new Error('Not connected to a server.');
  log.info('myLink → /kpi_meeting/my_link', { meeting_id: meetingId });
  const r = await jsonRpc(base, '/kpi_meeting/my_link', { meeting_id: meetingId });
  if (!r || !r.status || !r.url) throw new Error(r?.message || 'Could not open the meeting.');
  // Normally absolute (the public base URL). Make a bare path usable anyway.
  return /^https?:\/\//i.test(r.url) ? r.url : `${normalizeUrl(base)}${r.url}`;
}

// Join as ME: fetch my room link, then open it in the in-app browser (Jitsi needs
// a real browser for camera / mic; Expo Go has no WebRTC). Falls back to the
// system browser. Throws the server's sentence when there is no room for me.
export async function joinMeeting(meetingId) {
  const url = await myLink(meetingId);
  try {
    await WebBrowser.openBrowserAsync(url);
  } catch (e) {
    log.warn('openBrowserAsync failed, using Linking', e?.message);
    await Linking.openURL(url);
  }
  return url;
}

// The link the CLIENT is sent: Odoo's own /kpi/meet/<token> page, which embeds
// the room and records who joined. The first call mints the token, so this is
// only asked for when the admin taps "Share client link", never on load.
export async function clientLink(meetingId) {
  const url = await kw('kpi.meeting', 'page_url', [[meetingId]]);
  if (!url) throw new Error('This meeting has no link yet.');
  return url;
}
