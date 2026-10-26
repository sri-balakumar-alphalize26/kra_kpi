// CLIENT MESSAGES (managers) — mobile port of the web Approvals desk's
// "Questions" tab (web/components/admin/Approvals.jsx, web/lib/services/
// approvals.js). One list of kpi.doubt rows: a client's 💬 Discuss message
// (kind client_msg) and a developer's question to the manager.
//
// The rule it serves: no developer talks to a client and no client talks to a
// developer; the manager is the only bridge. The module has no HTTP routes for
// kpi.doubt, so these are plain ORM calls (call_kw) and the module's own
// _decider() refuses anybody who may not decide (models/kpi_doubt.py).
//
// call_kw goes through jsonRpc, not callKw: the decisions can end in a WhatsApp
// post, which outruns callKw's fixed 10s window (the web gives them 45s), and
// jsonRpc also reports an expired session the way every other screen does.
import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('ClientMessages');
const LONG = 45000;

async function server() {
  const { serverUrl } = await getConnection();
  return serverUrl || '';
}

const kw = (base, model, method, args = [], kwargs = {}) =>
  jsonRpc(base, '/web/dataset/call_kw', { model, method, args, kwargs }, LONG);

// Same field list as the web's listDoubts.
const DOUBT_FIELDS = ['display_ref', 'kpi_id', 'task_ref', 'client_kra_id', 'kind', 'question',
  'raised_by_id', 'raised_by_name', 'manager_user_id', 'state', 'answer', 'answered_by_id',
  'answered_at', 'client_posted_at', 'client_answer', 'meeting_id', 'create_date'];

// Words the web uses for kind / state (approvals.js doubtKindLabel, DOUBT_STATES).
export const doubtKindLabel = (k) => ({
  question: 'Question', meet_admin: 'Meet the manager', meet_client: 'Client meeting',
  escalation: 'Escalation', client_msg: '💬 Client message', client_meet: '📅 Client asked for a meeting',
})[k] || k;
export const DOUBT_STATES = {
  open: { label: 'Waiting for the manager', bg: '#FEF3C7', fg: '#B45309' },
  answered: { label: 'Answered', bg: '#DCFCE7', fg: '#15803D' },
  released: { label: 'Sent to the client', bg: '#DBEAFE', fg: '#1D4ED8' },
  client_replied: { label: 'Client replied', bg: '#DBEAFE', fg: '#1D4ED8' },
  rejected: { label: 'Not now', bg: '#F1F5F9', fg: '#475569' },
  closed: { label: 'Closed', bg: '#F1F5F9', fg: '#475569' },
};

const MOCK = [
  {
    id: 1, display_ref: 'D1', kpi_id: [10, 'Login page'], task_ref: 'REQ-0001', client_kra_id: [3, 'Acme'],
    kind: 'client_msg', question: 'Can the login page show our logo?', raised_by_id: false,
    raised_by_name: 'Ravi (Acme)', state: 'open', answer: false, client_posted_at: false,
    meeting_id: false, create_date: '2026-10-26 05:30:00',
  },
  {
    id: 2, display_ref: 'D2', kpi_id: [11, 'Invoice export'], task_ref: 'UPT-0004', client_kra_id: [3, 'Acme'],
    kind: 'question', question: 'Which date format does the client want?', raised_by_id: [7, 'Dev One'],
    raised_by_name: '', state: 'open', answer: false, client_posted_at: false,
    meeting_id: false, create_date: '2026-10-25 09:10:00',
  },
];

// The list. `all` false → only what still needs the manager (open + answered),
// the web's default; true → answered, sent and closed too.
export async function fetchDoubts({ all = false } = {}) {
  const base = await server();
  if (!base) return { isMock: true, doubts: MOCK };
  const domain = all ? [] : [['state', 'in', ['open', 'answered']]];
  log.info('fetchDoubts → kpi.doubt.search_read', { all });
  const rows = await kw(base, 'kpi.doubt', 'search_read', [domain],
    { fields: DOUBT_FIELDS, limit: 300, order: 'create_date desc' });
  log.info('fetchDoubts ←', { count: (rows || []).length });
  return { isMock: false, doubts: rows || [] };
}

// Answer. For a client message this goes to the CLIENT group as "our team"
// (kra.kpi.chat_post_team); for a developer's question it goes back to them.
export async function answerDoubt(id, text) {
  const base = await server();
  if (!base) return true;
  return kw(base, 'kpi.doubt', 'action_answer', [[id], text]);
}

// Put a developer's question to the client — the ONLY path to a client group.
export async function releaseDoubt(id, text) {
  const base = await server();
  if (!base) return true;
  return kw(base, 'kpi.doubt', 'action_release_to_client', [[id], text || false]);
}

// "Not now". A client message gets a holding line in their chat instead.
export async function rejectDoubt(id, note) {
  const base = await server();
  if (!base) return true;
  return kw(base, 'kpi.doubt', 'action_reject', [[id], note || '']);
}

// Turn it into a meeting (internal ones open at once; client ones wait to be
// scheduled under Meetings).
export async function meetingFromDoubt(id) {
  const base = await server();
  if (!base) return true;
  return kw(base, 'kpi.doubt', 'action_make_meeting', [[id]]);
}

// 👨‍💻 Who a client message can be handed to: [{id, name}], the people on the
// task first, then the Developer role.
export async function devOptionsForDoubt(id) {
  const base = await server();
  if (!base) return [{ id: 7, name: 'Dev One' }];
  const res = await kw(base, 'kpi.doubt', 'chat_dev_options', [[id]]);
  return Array.isArray(res) ? res : [];
}

// Same hand-off as the WhatsApp "👨‍💻 → name" buttons: the developer gets it
// privately, the group is told, the client gets their chat link.
// → { sent_to: [names], unreachable: [names] }
export async function askDeveloper(id, userId) {
  const base = await server();
  if (!base) return { sent_to: ['Dev One'], unreachable: [] };
  return kw(base, 'kpi.doubt', 'action_ask_developer', [[id], Number(userId)]);
}
