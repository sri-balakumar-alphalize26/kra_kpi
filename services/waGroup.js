// WhatsApp group reporting — which updates get posted to the team group, and in
// what words. Wraps /kpi_wa_group/* in controllers/kpi_reports_api.py.
//
// Scope note: the app does NOT choose the destination group. That is a web-only
// action, because picking the wrong group posts to it — which has happened — and
// the picker needs the group list, naming and confirmation flow to be safe. Here
// we only switch events on and off and edit their wording.

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('WaGroup');

// Mirrors PREVIEW_SAMPLES in models/kpi_wa_group_event.py. Only used offline —
// with a server, the samples come down with the events so the two cannot drift.
const MOCK_SAMPLES = {
  dev: 'Ramesh', time: '09:02 AM', date: 'Mon 17 Aug', hours: '8h 30m',
  tasks: '5 task(s) touched · 3 completed', note: 'finished the invoice screen',
  title: 'Fix the invoice PDF', ref: '#1042', client: 'Keerthana Silks',
  project: 'Billing', priority: 'Regular', deadline: '20 Aug 2026',
  elapsed: '2h 15m', pause_reason: 'Waiting on client', now: '09:02 AM',
};

const MOCK_EVENTS = [
  {
    event: 'workday_start', label: 'Workday started',
    help: 'When a developer presses Start Workday.', enabled: true,
    template: '🟢 *Workday started*\n{dev}\n{time} · {date}',
    default: '🟢 *Workday started*\n{dev}\n{time} · {date}',
    tokens: ['dev', 'time', 'date'],
  },
  {
    event: 'workday_end', label: 'Workday ended',
    help: 'When a developer presses End Workday.', enabled: true,
    template: '🔴 *Workday ended*\n{dev}\n{time} · {date} · {hours} logged\n{tasks}\n📝 "{note}"',
    default: '🔴 *Workday ended*\n{dev}\n{time} · {date} · {hours} logged\n{tasks}\n📝 "{note}"',
    tokens: ['dev', 'time', 'date', 'hours', 'tasks', 'note'],
  },
  // The five task events, all off by default — same as the server registry.
  // Offline used to list only the two workday events, so the demo showed a
  // smaller feature than the real one.
  {
    event: 'complete', label: 'Task completed',
    help: 'When a developer marks a task complete.', enabled: false,
    template: '✅ *Task completed*\n{title} ({ref})\n{dev} · {elapsed}',
    default: '✅ *Task completed*\n{title} ({ref})\n{dev} · {elapsed}',
    tokens: ['dev', 'title', 'ref', 'client', 'project', 'elapsed'],
  },
  {
    event: 'final_approved', label: 'Task signed off',
    help: 'When a completed task is finally approved.', enabled: false,
    template: '🏁 *Signed off*\n{title} ({ref})\n{client}',
    default: '🏁 *Signed off*\n{title} ({ref})\n{client}',
    tokens: ['dev', 'title', 'ref', 'client', 'project'],
  },
  {
    event: 'start', label: 'Task started',
    help: 'When a developer starts working on a task.', enabled: false,
    template: '▶️ *Task started*\n{title} ({ref})\n{dev}',
    default: '▶️ *Task started*\n{title} ({ref})\n{dev}',
    tokens: ['dev', 'title', 'ref', 'client', 'project', 'priority', 'deadline'],
  },
  {
    event: 'pause', label: 'Task paused',
    help: 'When a developer pauses a task.', enabled: false,
    template: '⏸ *Task paused*\n{title} ({ref})\n{dev} · {pause_reason}',
    default: '⏸ *Task paused*\n{title} ({ref})\n{dev} · {pause_reason}',
    tokens: ['dev', 'title', 'ref', 'elapsed', 'pause_reason'],
  },
  {
    event: 'resume', label: 'Task resumed',
    help: 'When a developer resumes a paused task.', enabled: false,
    template: '⏵ *Task resumed*\n{title} ({ref})\n{dev}',
    default: '⏵ *Task resumed*\n{title} ({ref})\n{dev}',
    tokens: ['dev', 'title', 'ref', 'elapsed'],
  },
];

/** Every reportable event with its switch, wording, built-in default and tokens.
 *  The route returns the effective wording AND the default in one call, which is
 *  what lets "Reset to default" work without a second round-trip. */
export async function fetchGroupEvents() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    log.info('fetchGroupEvents — no server, mock');
    return { status: true, isMock: true, events: MOCK_EVENTS, samples: MOCK_SAMPLES };
  }
  const r = await jsonRpc(serverUrl, '/kpi_wa_group/events', {});
  return {
    status: !!r?.status, isMock: false,
    events: r?.events || [],
    samples: r?.samples || {},
    message: r?.message || '',
  };
}

/** Save one event's switch and/or wording. Both optional, mirroring the route.
 *  An empty template means "use the built-in default" — that is the server's
 *  convention, and it is why Reset never has to know the default text. */
export async function setGroupEvent({ event, enabled, template }) {
  const { serverUrl } = await getConnection();
  const params = { event };
  if (enabled != null) params.enabled = enabled;
  if (template != null) params.template = template;
  if (!serverUrl) return { status: true, event, enabled, template };
  return jsonRpc(serverUrl, '/kpi_wa_group/set_event', params);
}

/** Post one event's wording to the group, filled with sample values.
 *
 *  `confirmJid` is not optional padding: the route refuses unless the caller
 *  echoes back the exact destination it is posting to. That guard exists because
 *  test messages once went into a live client group.
 */
export async function testGroupEvent(event, confirmJid) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    return { status: false, message: 'Not connected to a server — nothing was sent.' };
  }
  return jsonRpc(serverUrl, '/kpi_wa_group/test_event', { event, confirm_jid: confirmJid });
}
