// Stage-1 client pre-approval — IN-APP. When an admin assigns a developer to a
// client's task, the client is asked (in-app, via the bell + push) to sign off on
// WHO it went to. They Approve / Reject right here — no WhatsApp link, no token.
// If they stay silent the server auto-approves after the configured window
// (res.company.client_approval_minutes, Configuration → Timers & Away).
//
// Wraps /kpi_pre_approval/* in controllers/kpi_reports_api.py. Both routes are
// caller-scoped SERVER-SIDE, so a client only ever sees / decides their own tasks.
import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('PreApproval');

// Tasks awaiting THIS client's approval → the "Approval needed" section.
// Each: { id, name, kind, external_ref, description, client_name, project_name,
//         priority, task_state, developer, deadline_at, server_now }
// `deadline_at` + `server_now` drive the "auto-approves in mm:ss" countdown —
// both are server clocks, so a wrong device time can't skew it.
export async function fetchPreApprovals() {
  const { serverUrl, db } = await getConnection();
  if (!serverUrl) return { kpis: [] };
  const res = await jsonRpc(serverUrl, '/kpi_pre_approval/list', {}, undefined, db);
  if (!res || res.status === false) throw new Error(res?.message || 'Could not load approvals');
  log.info('list ←', { count: (res.kpis || []).length });
  return { kpis: res.kpis || [] };
}

// Stop ('hold') / restart ('resume') the auto-approve countdown. NOT a decision:
// the task stays awaiting the client, who can still Approve/Reject afterwards.
// Server-side this just clears/re-arms pre_approval_deadline_at.
export async function holdPreApproval(kpiId, hold) {
  const { serverUrl, db } = await getConnection();
  if (!serverUrl) return { status: true, held: !!hold };
  const res = await jsonRpc(
    serverUrl, '/kpi_pre_approval/decide',
    { kpi_id: kpiId, action: hold ? 'hold' : 'resume' }, undefined, db,
  );
  if (!res || res.status === false) throw new Error(res?.message || 'Could not update the hold');
  log.info('hold ←', { kpiId, held: res.held });
  return res;
}

// action: 'approve' | 'reject'. `feedback` is shown to the team on a reject.
// Server returns { status, state, decision, message, late } from the shared
// decision engine (record_client_pre_decision) — `late: true` means the window
// had already closed (it was auto-approved), which the UI should surface.
export async function decidePreApproval(kpiId, action, feedback) {
  const { serverUrl, db } = await getConnection();
  if (!serverUrl) return { status: true, state: 'pre_approval_approved' };
  const res = await jsonRpc(
    serverUrl, '/kpi_pre_approval/decide',
    { kpi_id: kpiId, action, feedback: feedback || '' }, undefined, db,
  );
  if (!res || res.status === false) throw new Error(res?.message || 'Could not save your decision');
  log.info('decide ←', { kpiId, action, state: res.state, late: res.late });
  return res;
}

// ── Stage 2: FINAL sign-off ────────────────────────────────────────────────
// Different from the pre-approval above: that one approves WHO does the work,
// before it starts. This one accepts the FINISHED work after the admin has
// checked it (task_state 'awaiting_client'), and generates the signed completion
// certificate. It never auto-approves — it waits for the client.
//
// The server (/kpi_client_approval/approve) REQUIRES all three confirmations and
// a signature; it accepts a typed name in place of an uploaded signature image.
export async function submitClientSignoff(kpiId, { signatureText, notes } = {}) {
  const { serverUrl, db } = await getConnection();
  if (!serverUrl) return { status: true };
  const res = await jsonRpc(
    serverUrl, '/kpi_client_approval/approve',
    {
      kpi_id: kpiId,
      signature_text: (signatureText || '').trim(),
      // The three tick-boxes the client confirms in the popup. The route rejects
      // the call unless all three are true, so they're sent as literal trues.
      chk_delivered: true,
      chk_works: true,
      chk_authorized: true,
      notes: notes || '',
    },
    undefined, db,
  );
  if (!res || res.status === false) throw new Error(res?.message || 'Could not submit your sign-off');
  log.info('signoff ←', { kpiId });
  return res;
}
