// The payloads in LIVE_* below are not invented — they were captured from the
// running 369application database by calling the real serializer
// (controllers/kra_api._gate_keys) against real tasks in each gate state. If the
// server's wording or reason keys ever change, these fixtures go stale and the
// tests here start passing against a contract that no longer exists — so
// re-capture them rather than editing them to match.

const { gateLabel, fmtWhen } = require('../taskGate');

// Developer has not started their workday. Reason is about the VIEWER.
const LIVE_NO_WORKDAY = {
  can_start: false,
  start_block_reason: 'workday',
  start_block_message:
    "Start your workday before working on 'BUG-001'. Your task time has to land "
    + 'inside a workday session, or it is recorded against nothing.',
  task_state: 'paused',
};

// Workday open but frozen. Distinct reason so the wording can say "Resume".
const LIVE_WORKDAY_PAUSED = {
  can_start: false,
  start_block_reason: 'workday_paused',
  start_block_message: "Your workday is paused. Resume it before working on 'BUG-001'.",
  task_state: 'paused',
};

const LIVE_ALLOWED = {
  can_start: true,
  start_block_reason: '',
  start_block_message: '',
  task_state: 'paused',
};

// THE TRAP. A completed task also reports can_start=false, and the server still
// carries the last gate it evaluated — 'client'. Captured verbatim from REQ-042.
const LIVE_COMPLETED = {
  can_start: false,
  start_block_reason: 'client',
  start_block_message:
    "'REQ-042' is waiting for the client to approve who works on it. It releases "
    + "automatically if they don't reply.",
  task_state: 'completed',
};

describe('gateLabel — the viewer gates come first', () => {
  test('no workday tells them to start their day, not blame the client', () => {
    expect(gateLabel(LIVE_NO_WORKDAY)).toBe('Start your workday to work on tasks');
  });

  test('paused workday says Resume — the button they actually need', () => {
    expect(gateLabel(LIVE_WORKDAY_PAUSED)).toBe('Resume your workday to work on tasks');
  });

  test('the two workday states never share wording', () => {
    expect(gateLabel(LIVE_NO_WORKDAY)).not.toBe(gateLabel(LIVE_WORKDAY_PAUSED));
  });
});

describe('gateLabel — no badge when there is nothing to wait for', () => {
  test('a startable task shows nothing', () => {
    expect(gateLabel(LIVE_ALLOWED)).toBe('');
  });

  // Regression guard: gating the badge on can_start alone stamps
  // "Waiting for the client to approve" across every finished card.
  test.each(['completed', 'awaiting_client', 'partially_completed'])(
    'finished task (%s) shows nothing despite can_start=false',
    (state) => {
      expect(gateLabel({ ...LIVE_COMPLETED, task_state: state })).toBe('');
    },
  );

  test('missing can_start (older server) is treated as allowed, not blocked', () => {
    expect(gateLabel({ task_state: 'paused' })).toBe('');
  });

  test('a null task never throws', () => {
    expect(gateLabel(null)).toBe('');
  });
});

describe('gateLabel — approval gates', () => {
  test('admin gate without a deadline', () => {
    expect(gateLabel({ can_start: false, start_block_reason: 'admin', task_state: 'assigned' }))
      .toBe('Waiting for an admin to accept this task');
  });

  test('admin gate with a deadline names the time', () => {
    const out = gateLabel({
      can_start: false, start_block_reason: 'admin', task_state: 'assigned',
      admin_accept_deadline_at: '2026-07-29 09:05:00',
    });
    expect(out).toMatch(/^Waiting on admin — accepts automatically at \d{1,2}:\d{2}/);
  });

  test('a held client approval is called out separately', () => {
    expect(gateLabel({
      can_start: false, start_block_reason: 'client', task_state: 'assigned',
      pre_approval_held: true,
    })).toBe('Client put approval on hold');
  });

  test('client gate falls back to undated wording with no release time', () => {
    expect(gateLabel({ can_start: false, start_block_reason: 'client', task_state: 'assigned' }))
      .toBe('Waiting for the client to approve');
  });
});

describe('fmtWhen — the server sends a form JS need not parse', () => {
  test("'YYYY-MM-DD HH:MM:SS' parses instead of yielding Invalid Date", () => {
    expect(fmtWhen('2026-07-29 09:05:00')).toMatch(/^at \d{1,2}:\d{2}/);
  });

  test('ISO with T also works', () => {
    expect(fmtWhen('2026-07-29T09:05:00')).toMatch(/^at \d{1,2}:\d{2}/);
  });

  test('empty and unparseable input yield no text, never "Invalid Date"', () => {
    expect(fmtWhen('')).toBe('');
    expect(fmtWhen(null)).toBe('');
    expect(fmtWhen('not a date')).toBe('');
  });
});
