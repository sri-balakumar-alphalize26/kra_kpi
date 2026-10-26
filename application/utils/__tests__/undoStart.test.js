const { canOfferUndoStart, undoStartConfirm } = require('../undoStart');
const { fmtHMS } = require('../liveTime');

const TASK = {
  id: 9, name: 'Login screen', external_ref: 'REQ-012', task_state: 'paused',
  can_undo_start: true, today_seconds: 754, undo_start_prev_state_label: 'Assigned',
};

describe('canOfferUndoStart', () => {
  it('shows for a running or paused task the server flags', () => {
    expect(canOfferUndoStart(TASK)).toBe(true);
    expect(canOfferUndoStart({ ...TASK, task_state: 'in_progress' })).toBe(true);
  });

  it('hides when the server does not say so (older server, or false)', () => {
    const { can_undo_start, ...old } = TASK;
    expect(canOfferUndoStart(old)).toBe(false);
    expect(canOfferUndoStart({ ...TASK, can_undo_start: false })).toBe(false);
  });

  it('hides while read-only, and past running / paused whatever the flag says', () => {
    expect(canOfferUndoStart(TASK, { readOnly: true })).toBe(false);
    expect(canOfferUndoStart({ ...TASK, task_state: 'completed' })).toBe(false);
    expect(canOfferUndoStart(null)).toBe(false);
  });
});

describe('undoStartConfirm', () => {
  it('names the task, the time removed and where it goes back to', () => {
    const c = undoStartConfirm(TASK, fmtHMS);
    expect(c.title).toBe('Undo starting this task?');
    expect(c.confirmLabel).toBe('Undo start');
    expect(c.message).toContain('REQ-012 Login screen');
    expect(c.message).toContain(fmtHMS(754));
    expect(c.message).toContain('goes back to Assigned');
    expect(c.message).toContain('cannot be undone');
  });

  it("names who started it, and quotes no figure when the viewer has no time on it (an admin undoing a developer's start)", () => {
    const c = undoStartConfirm({ ...TASK, today_seconds: 0, undo_start_by: 'Sri Balakumar' }, fmtHMS);
    expect(c.message).toContain('REQ-012 Login screen (started by Sri Balakumar)');
    expect(c.message).toContain('the time logged on it today is removed');
    expect(c.message).not.toContain(fmtHMS(0));
  });

  it('ends with what is kept, when the server says something is', () => {
    const keeps = "Today's 2 updates and 1 link on this task are kept. Only the time and status are undone.";
    const c = undoStartConfirm(TASK, fmtHMS, keeps);
    expect(c.message).toContain('cannot be undone');
    expect(c.message.endsWith(`✅ ${keeps}`)).toBe(true);
  });

  it('says nothing about kept work when there is none (or an older server)', () => {
    expect(undoStartConfirm(TASK, fmtHMS, '').message).not.toContain('✅');
    expect(undoStartConfirm(TASK, fmtHMS, '   ').message).not.toContain('✅');
    expect(undoStartConfirm(TASK, fmtHMS).message.endsWith('This cannot be undone.')).toBe(true);
  });

  it('still reads when the server sent no previous state', () => {
    const c = undoStartConfirm({ ...TASK, undo_start_prev_state_label: '' }, fmtHMS);
    expect(c.message).toContain('where it was before today');
  });
});
