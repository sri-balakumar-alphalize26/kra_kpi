// After the client's check (server: models/kpi_finish.py, kpi_billing.py,
// kpi_client_sendback.py). Every task payload — the board's and KPI Details' —
// carries the same fields, so the card and the detail screen read them here:
//
//   full_complete_pending + full_complete_missing   waiting for 🏁 Full Complete
//   full_complete_at + bill                         fully complete, billed
//   full_complete_at + no bill (+ bill_off)         fully complete, 🧾 Bill now (admins)
//   sendbacks / client_revert_count                 every time the client sent it back
//
// Pure, so the rules the web's FinishBox / SendBackHistory follow are
// unit-tested once (utils/__tests__/taskFinish.test.js).

// What the finish box shows, or null when the task is not that far yet:
//   { kind: 'pending', missing: [sentences] }
//   { kind: 'billed', bill, status: 'Paid' | 'Client says paid' | 'Unpaid' }
//   { kind: 'no_bill', billOff }     — admins only, like the web
export function finishState(task, { isAdmin = false } = {}) {
  const t = task || {};
  if (t.full_complete_pending) {
    return { kind: 'pending', missing: Array.isArray(t.full_complete_missing) ? t.full_complete_missing.filter(Boolean) : [] };
  }
  if (!t.full_complete_at) return null;
  const bill = t.bill && t.bill.id ? t.bill : null;
  if (bill) {
    return { kind: 'billed', bill, status: bill.paid ? 'Paid' : bill.client_says_paid ? 'Client says paid' : 'Unpaid' };
  }
  return isAdmin ? { kind: 'no_bill', billOff: !!t.bill_off } : null;
}

// Who may tap 🏁 Full Complete: the developer on the task or an admin — the
// server's own rule (kra.kpi._may_full_complete), which also refuses anyone else.
export const canFullComplete = (task, { isAdmin = false, userId = null } = {}) =>
  !!task && !!task.full_complete_pending
  && (isAdmin || (!!userId && !!task.user_id && String(task.user_id) === String(userId)));

// A refused Full Complete, as one readable message.
export function fullCompleteRefusal(res) {
  const missing = (res && Array.isArray(res.missing)) ? res.missing.filter(Boolean) : [];
  if (missing.length) return `Before Full Complete:\n${missing.map((m) => `• ${m}`).join('\n')}`;
  return (res && res.message) || 'Could not complete it';
}

// The client's send-back rounds, newest first as the server sends them.
export const sendBackRounds = (task) => (task && Array.isArray(task.sendbacks) ? task.sendbacks : []);

// The card's one closed line: "↩ Client sent it back 2× · 📷 2 photos" — the
// newest round's proof, as the web's card shows it. '' when never sent back.
export function sendBackLine(task) {
  const rounds = sendBackRounds(task);
  const n = rounds.length || (task && task.client_revert_count) || 0;
  if (!n) return '';
  const files = rounds[0] && rounds[0].files_label ? ` · ${rounds[0].files_label}` : '';
  return `↩ Client sent it back ${n}×${files}`;
}
