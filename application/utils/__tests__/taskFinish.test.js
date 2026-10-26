const {
  finishState, canFullComplete, fullCompleteRefusal, sendBackRounds, sendBackLine,
} = require('../taskFinish');

const BILL = { id: 171, name: 'INV/2026/0171', amount: 1189.4, money: '1,189.40', paid: false, auto: false, client_says_paid: true };

describe('finishState', () => {
  it('is nothing before the client review is over', () => {
    expect(finishState({ task_state: 'awaiting_client', full_complete_pending: false, full_complete_at: '' })).toBe(null);
    expect(finishState(null)).toBe(null);
  });

  it('waits for Full Complete with what is still missing', () => {
    const s = finishState({ full_complete_pending: true, full_complete_missing: ['Upload the user manual.', ''] });
    expect(s).toEqual({ kind: 'pending', missing: ['Upload the user manual.'] });
    expect(finishState({ full_complete_pending: true }).missing).toEqual([]);
  });

  it('shows the bill once fully complete, with its paid state', () => {
    expect(finishState({ full_complete_at: '2026-08-13 14:42:50', bill: BILL })).toEqual({ kind: 'billed', bill: BILL, status: 'Client says paid' });
    expect(finishState({ full_complete_at: 'x', bill: { ...BILL, paid: true } }).status).toBe('Paid');
    expect(finishState({ full_complete_at: 'x', bill: { ...BILL, client_says_paid: false } }).status).toBe('Unpaid');
  });

  it('offers Bill now to admins only when there is no bill (server sends bill: {})', () => {
    expect(finishState({ full_complete_at: 'x', bill: {}, bill_off: true }, { isAdmin: true })).toEqual({ kind: 'no_bill', billOff: true });
    expect(finishState({ full_complete_at: 'x', bill: {} }, { isAdmin: true })).toEqual({ kind: 'no_bill', billOff: false });
    expect(finishState({ full_complete_at: 'x', bill: {} })).toBe(null);
  });
});

describe('canFullComplete', () => {
  const T = { id: 1, user_id: 7, full_complete_pending: true };
  it('is the developer on the task or an admin', () => {
    expect(canFullComplete(T, { userId: 7 })).toBe(true);
    expect(canFullComplete(T, { userId: '7' })).toBe(true);
    expect(canFullComplete(T, { userId: 8 })).toBe(false);
    expect(canFullComplete(T, { isAdmin: true })).toBe(true);
    expect(canFullComplete({ ...T, user_id: false }, { userId: 7 })).toBe(false);
  });
  it('only while it waits for Full Complete', () => {
    expect(canFullComplete({ ...T, full_complete_pending: false }, { isAdmin: true })).toBe(false);
  });
});

describe('fullCompleteRefusal', () => {
  it('lists what is missing, else the server message', () => {
    expect(fullCompleteRefusal({ status: false, message: 'x', missing: ['Add the GitHub link.', 'Upload the manual.'] }))
      .toBe('Before Full Complete:\n• Add the GitHub link.\n• Upload the manual.');
    expect(fullCompleteRefusal({ status: false, message: 'Only the developer on this task or an admin can do Full Complete.' }))
      .toBe('Only the developer on this task or an admin can do Full Complete.');
    expect(fullCompleteRefusal(null)).toBe('Could not complete it');
  });
});

describe('send-back rounds', () => {
  const rounds = [
    { id: 2, round: 2, reason: 'Still wrong', files: [{ id: 9, kind: 'image' }, { id: 10, kind: 'image' }], files_label: '📷 2 photos' },
    { id: 1, round: 1, reason: 'Button missing', files: [], files_label: '' },
  ];
  it('reads the rounds, and nothing when there are none', () => {
    expect(sendBackRounds({ sendbacks: rounds })).toBe(rounds);
    expect(sendBackRounds({})).toEqual([]);
    expect(sendBackLine({ sendbacks: [] })).toBe('');
  });
  it('says how many times, with the newest round’s proof', () => {
    expect(sendBackLine({ sendbacks: rounds, client_revert_count: 2 })).toBe('↩ Client sent it back 2× · 📷 2 photos');
    expect(sendBackLine({ sendbacks: [rounds[1]] })).toBe('↩ Client sent it back 1×');
    // An older round list missing but the count there still says it happened.
    expect(sendBackLine({ client_revert_count: 3 })).toBe('↩ Client sent it back 3×');
  });
});
