// CLIENT TALKS — 💬 Discussions · 📅 Meetings · ❓ Questions. Mobile port of the
// web's Client Talks pages (web/lib/services/talks.js) over the same Odoo routes
// (controllers/kpi_talks_api.py). The server already groups a chat by date and
// into "talks" (a new talk after 60 minutes of quiet) and lays each meeting out
// as one card, so this file only calls and checks.
//
// Scoping is server-side: admins get everything, everyone else only the tasks /
// meetings / questions they are on. A failure answers {status:false, message},
// which is thrown here so the screen shows the server's own words.
import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('Talks');
// Discussions walks every task chat server-side; a big database outruns 10s.
const LONG = 45000;

async function server() {
  const { serverUrl } = await getConnection();
  return serverUrl || '';
}

function ok(res, what) {
  if (!res || res.status === false) {
    log.warn(`${what} ✗`, res?.message);
    throw new Error(res?.message || `Could not load the ${what}.`);
  }
  return res;
}

// tab: 'task' | 'general' · filter: 'waiting' | 'all'
// → { rows:[{ kpi_id, is_general, ref, title, client, last, last_side, last_who,
//            at, at_label, count, waiting }],
//     counts:{ task, general, waiting_task, waiting_general } }
export async function fetchDiscussions(tab, filter, search) {
  const base = await server();
  if (!base) return { isMock: true, rows: [], counts: {} };
  const res = await jsonRpc(base, '/kpi_action/talks/discussions',
    { tab, filter, search: search || '' }, LONG);
  return ok(res, 'discussions');
}

// One chat → { kpi_id, is_general, ref, title, client, count, waiting,
//   days:[{ date, label, sessions:[{ n, start, end, count, status, by, gap_min,
//           messages:[{ id, side, who, body, files:[{id,name,kind,url}], time }] }] }] }
// status: 'answered' | 'waiting' | 'no_reply'. Days are newest first, talks in a
// day oldest first.
export async function fetchThread(kpiId) {
  const base = await server();
  if (!base) return { isMock: true, days: [], count: 0 };
  const res = await jsonRpc(base, '/kpi_action/talks/thread', { kpi_id: kpiId }, LONG);
  return ok(res, 'chat');
}

// tab: 'task' | 'general' · filter: 'upcoming' | 'past' | 'all'
// → { days:[{ date, label, upcoming, meetings:[card] }], counts:{ task, general, upcoming } }
// card: { id, name, state, state_label, upcoming, kpi_id, is_general, ref, title,
//   client, db, when, local_when, minutes, organizer, asked_by, booked, internal,
//   attendance:[{name, minutes, staff, removed, absent, joined, left}],
//   summary, action_items, transcript, notes, recordings:[{id,name,mime,size,url}],
//   can_join }
export async function fetchTalkMeetings(tab, filter, search) {
  const base = await server();
  if (!base) return { isMock: true, days: [], counts: {} };
  const res = await jsonRpc(base, '/kpi_action/talks/meetings',
    { tab, filter, search: search || '' }, LONG);
  return ok(res, 'meetings');
}

// filter: 'open' | 'answered' | 'all'
// → { rows:[{ id, kind, kind_label, kpi_id, is_general, ref, title, client,
//            question, raised_by, with_now, step, state, state_label, open,
//            age_min, answer, meeting_id, at }], counts:{ open, answered } }
// `at` is the UTC create date 'YYYY-MM-DD HH:MM:SS'.
export async function fetchQuestions(filter, search) {
  const base = await server();
  if (!base) return { isMock: true, rows: [], counts: {} };
  const res = await jsonRpc(base, '/kpi_action/talks/questions',
    { filter, search: search || '' }, LONG);
  return ok(res, 'questions');
}

// One colour per talk in a day, in turn: blue, amber, green, violet (Odoo
// TALK_COLOURS, same as the web).
export const TALK_COLOURS = [
  { bar: '#2F6FDB', band: '#EAF1FD', text: '#1D4FA8' },
  { bar: '#B45309', band: '#FDF3E4', text: '#8A4108' },
  { bar: '#15803D', band: '#E8F6EE', text: '#0F5E2D' },
  { bar: '#7C3AED', band: '#F1EBFD', text: '#5B21B6' },
];
export const colour = (i) => TALK_COLOURS[i % TALK_COLOURS.length];

export const gapLabel = (min) => (min >= 60
  ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}` : `${min} min`);
export const ageLabel = (min) => (min < 60 ? `${min} min`
  : min < 1440 ? `${Math.floor(min / 60)} h` : `${Math.floor(min / 1440)} d`);
export const kindIcon = (k) => ({
  client_msg: '💬', client_meet: '📅', meet_admin: '📅', meet_client: '📅', escalation: '⬆️',
}[k] || '🙋');
