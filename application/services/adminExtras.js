// ADMIN EXTRAS — the admin-side routes the web and Odoo already had and the app
// did not: refused client requests, CEO numbers, Finish & client review, the
// Approval Chain, the Live Tracking employee popup (profile, nudge) and taking
// forgotten time off yesterday. Same routes and params as the web
// (web/lib/services/admin.js, settings.js, kpiActions.js). Every route answers
// {status:false, message} for a caller without rights rather than raising, so
// screens must read `status`, not just await.
import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('AdminExtras');
// Routes that touch many rows (refused list) or post to WhatsApp (restore tells
// the client) can outrun the default 10s window. The web allows 45s too.
const LONG = 45000;

async function server() {
  const { serverUrl } = await getConnection();
  return serverUrl || '';
}

// Model method through call_kw, via jsonRpc so the timeout and the expired-
// session handling are the same as every route call (odooApi.callKw has neither).
async function kw(base, model, method, args = [], kwargs = {}) {
  return jsonRpc(base, `/web/dataset/call_kw/${model}/${method}`,
    { model, method, args, kwargs }, LONG);
}

// ── Client Task Queue › 🚫 Refused ─────────────────────────────────────────
// Requests an admin declined: archived, not deleted, with the reason the
// client was shown. Row: { id, name, external_ref, client_name, project_name,
// received_at, declined_at, declined_by, reason, note, decline_count,
// client_answer, client_answer_label, description, submitted_by,
// attachments:[{id,file_name,reason}] }. Dates arrive 'YYYY-MM-DD HH:MM'.
export async function fetchRefused() {
  const base = await server();
  if (!base) return { status: true, isMock: true, refused: [] };
  const res = await jsonRpc(base, '/kpi_pending_queue/refused', {}, LONG);
  log.info('fetchRefused ←', { status: res?.status, count: (res?.refused || []).length });
  return res || { status: false, message: 'Could not load the refused requests.', refused: [] };
}

// Back to the client queue (Pending), where it can be published or refused
// again. The refusal stays in its history. → { status, message }
export async function restoreRefused(kpiId) {
  const base = await server();
  if (!base) return { status: false, message: 'No server is configured — nothing was restored.' };
  log.info('restoreRefused →', { kpi_id: kpiId });
  return (await jsonRpc(base, '/kpi_pending_queue/restore', { kpi_id: Number(kpiId) }, LONG))
    || { status: false, message: 'Could not restore it.' };
}

// ── Configuration › CEO daily summary ──────────────────────────────────────
// The WhatsApp number(s) each End Workday's snapshot + summary goes to,
// comma-separated; empty switches it off. Read from /kpi_config/get
// (ceo_wa_numbers). The server cleans each number (adds the company dial code
// to a bare local one) and answers { status, numbers } — show what it stored.
export async function fetchCeoNumbers() {
  const base = await server();
  if (!base) return { status: true, numbers: '' };
  const cfg = await jsonRpc(base, '/kpi_config/get', {});
  return { status: cfg?.status !== false, numbers: cfg?.ceo_wa_numbers || '' };
}
export async function setCeoNumbers(numbers) {
  const base = await server();
  if (!base) return { status: true, numbers: numbers || '' };
  return jsonRpc(base, '/kpi_config/set_ceo_numbers', { numbers: numbers || '' });
}

// ── Configuration › 🏁 Finish & client review ──────────────────────────────
// review_days: days the client has to check finished work (1-60).
// skip_admin: true = the developer's Partial Complete goes straight to the
// client; false = an admin checks it first. Both routes answer the SAVED
// { status, review_days, skip_admin }.
export async function fetchFinishConfig() {
  const base = await server();
  if (!base) return { status: true, review_days: 3, skip_admin: false };
  return jsonRpc(base, '/kpi_config/finish/get', {});
}
export async function setFinishConfig(vals) {
  const base = await server();
  if (!base) return { status: true, review_days: 3, skip_admin: false, ...(vals || {}) };
  return jsonRpc(base, '/kpi_config/finish/set', vals || {});
}

// ── Configuration › Approval chain (kpi.escalation.tier) ───────────────────
// Who decides a new client request, in order. Same reads and writes as the web
// card (web/components/settings/ApprovalChainCard.jsx). Odoo's ACLs decide; a
// refusal arrives as a thrown error carrying Odoo's own message.
const TIER = 'kpi.escalation.tier';
const MOCK_TIERS = [
  { id: 1, name: 'Coordinator', sequence: 10, minutes: 5, use_task_manager: true, user_ids: [] },
  { id: 2, name: 'Owner', sequence: 20, minutes: 10, use_task_manager: false, user_ids: [2] },
];
export async function fetchApprovalChain() {
  const base = await server();
  if (!base) return { isMock: true, tiers: MOCK_TIERS, staff: [{ id: 2, name: 'Administrator', number: '919000000000', canDecide: true }] };
  const [tiers, users] = await Promise.all([
    kw(base, TIER, 'search_read', [[]], { fields: ['name', 'sequence', 'minutes', 'use_task_manager', 'user_ids'], order: 'sequence, id' }),
    kw(base, 'res.users', 'search_read', [[['share', '=', false]]], { fields: ['name', 'kpi_wa_number', 'kpi_mobile_number', 'kpi_role'], order: 'name' }),
  ]);
  // Only admins / coordinators can decide; the rest are kept so a step that
  // names one can still show who it is.
  const staff = (users || []).map((u) => ({
    id: u.id, name: u.name, number: u.kpi_wa_number || u.kpi_mobile_number || '',
    canDecide: u.kpi_role === 'admin' || u.kpi_role === 'coordinator',
  }));
  return { isMock: false, tiers: tiers || [], staff };
}
export async function writeTier(id, vals) {
  const base = await server();
  if (!base) return true;
  return kw(base, TIER, 'write', [[id], vals]);
}
export async function createTier(vals) {
  const base = await server();
  if (!base) return 99;
  return kw(base, TIER, 'create', [[vals]]);
}
export async function deleteTier(id) {
  const base = await server();
  if (!base) return true;
  return kw(base, TIER, 'unlink', [[id]]);
}

// ── Live Tracking › employee popup ─────────────────────────────────────────
// { status, user_id, contact:{name, login, role, mobile, dial, country,
//   whatsapp, app_login_enabled, last_app_login, last_device, allow_multitask,
//   pin_is_default}, workload:{tasks:[{id, ref, name, client, state,
//   state_label, deadline, overdue, due_week, estimate_h, spent_h}],
//   counts:{running, paused, todo, hold, approval}, open, overdue, due_week,
//   est_total, spent_total, done_today, done_week, done_month},
//   questions:[{id, ref, question, days}], meetings_today:[{id, time, name,
//   state, join_url}], attendance:{days:[{date, status, first_login}],
//   totals:{on_time, late, absent, off, holiday, before_join, working_days},
//   joined, cutoff} }. The PIN itself is never sent — only pin_is_default.
export async function fetchEmployeeProfile(userId) {
  const base = await server();
  if (!base) return { status: false, message: 'No server is configured.' };
  const res = await jsonRpc(base, '/kpi_owner/employee_profile', { user_id: Number(userId) }, LONG);
  log.info('fetchEmployeeProfile ←', { user_id: userId, status: res?.status });
  return res || { status: false, message: 'Could not load that person.' };
}

// Ping someone: a notification that an admin is checking in (or, for someone
// who has not started, asking them to start their workday). Rate-limited on
// the server to once per 10 minutes per person.
export async function nudgeUser(userId, note) {
  const base = await server();
  if (!base) return { status: false, message: 'No server is configured — nobody was nudged.' };
  return (await jsonRpc(base, '/kpi_owner/nudge_user', { user_id: Number(userId), note: (note || '').slice(0, 300) }))
    || { status: false, message: 'Could not nudge.' };
}

// ── Reduce yesterday's forgotten time (admin) ──────────────────────────────
// What yesterday recorded on one task: { status, date, date_display, seconds,
// display, last_end, people:[{name, display}], intervals:[{who, start, end,
// display}], day_totals:[{name, display, tasks}], task_total_display,
// reasons:[{key, label}] }. Admin only.
export async function fetchPrevDayTime(kpiId) {
  const base = await server();
  if (!base) return { status: false, message: 'No server is configured.' };
  return (await jsonRpc(base, '/kra_kpi/task/prev_day_time', { kpi_id: Number(kpiId) }))
    || { status: false, message: "Could not load yesterday's time." };
}
// Takes time off the END of yesterday only, decrease only. reason_code is one
// of the keys above; 'other' needs reason_text. → { status, message }
export async function reducePrevDay(kpiId, { hours, minutes, reasonCode, reasonText }) {
  const base = await server();
  if (!base) return { status: false, message: 'No server is configured — nothing was changed.' };
  return (await jsonRpc(base, '/kra_kpi/task/reduce_prev_day', {
    kpi_id: Number(kpiId), hours: Number(hours) || 0, minutes: Number(minutes) || 0,
    reason_code: reasonCode || '', reason_text: reasonText || '',
  })) || { status: false, message: "Could not reduce yesterday's time." };
}
