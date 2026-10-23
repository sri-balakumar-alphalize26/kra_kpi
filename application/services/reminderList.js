// REMINDERS — wraps the `kpi.reminder` model (kra_kpi_module).
//
// A reminder that is NOT attached to a task: a name, a date, a time, optionally
// a client/KRA. The same rows the web's KRA/KPI → My Work → Reminders menu shows,
// so a reminder made here appears there and vice versa.
//
// NOT services/reminders.js — that is a different thing entirely: the on-device
// scheduler for TASK reminders ("ping me in 20 minutes"), which never touches the
// server. These two must not be merged; one is a data service, the other is a
// notification scheduler.
//
// Reached through callKw rather than a controller, because it does not need one:
// the module's access rules already grant every internal user full CRUD on
// kpi.reminder, and a record rule scopes every row to user_id = uid. So the
// generic ORM endpoint is both sufficient and safe — a user physically cannot
// read somebody else's reminder through it.

import { getConnection } from '../api/session';
import { callKw } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('Reminders');
const MODEL = 'kpi.reminder';

// The fields the screen renders. next_trigger is the derived UTC instant the
// server computes from date + time in the owner's timezone — it is what a future
// on-device alarm would be armed from, which is why it is fetched even though
// nothing displays it raw yet.
const FIELDS = [
  'name', 'remind_date', 'remind_time', 'enabled', 'repeat',
  'next_trigger', 'kra_id', 'client_kra_id', 'completion_count',
];

async function base() {
  const { serverUrl } = await getConnection();
  return serverUrl || '';
}

// This user's reminders, soonest first.
//
// No user_id filter in the domain, deliberately: the record rule already applies
// one server-side. Adding it here would duplicate a rule that can change without
// this file knowing, and would quietly do nothing on a server where the rule was
// tightened.
export async function fetchReminders() {
  const b = await base();
  if (!b) return { status: false, message: 'No server connection' };
  try {
    const rows = await callKw(b, MODEL, 'search_read', [[], FIELDS], {
      order: 'next_trigger asc, id desc',
    });
    return { status: true, reminders: Array.isArray(rows) ? rows : [] };
  } catch (e) {
    // Most likely an older server without the model — an empty list reads better
    // than an error the user cannot act on.
    log.info('list failed (model missing?)', e?.message);
    return { status: false, notInstalled: true, message: e?.message || 'Unavailable' };
  }
}

// Create (no id) or update (id). Only the keys passed are written, so the screen
// can flip `enabled` from the list without resending the whole record.
export async function saveReminder({ id, name, remind_date, remind_time, enabled, repeat, kra_id }) {
  const b = await base();
  if (!b) return { status: false, message: 'No server connection' };
  const vals = {};
  if (name != null) vals.name = name;
  if (remind_date != null) vals.remind_date = remind_date;
  if (remind_time != null) vals.remind_time = remind_time;
  if (enabled != null) vals.enabled = !!enabled;
  if (repeat != null) vals.repeat = repeat;
  // false clears the link; undefined leaves it alone. Both are meaningful, which
  // is why this tests for undefined rather than falsiness.
  if (kra_id !== undefined) vals.kra_id = kra_id ? Number(kra_id) : false;
  try {
    if (id) {
      await callKw(b, MODEL, 'write', [[Number(id)], vals]);
      return { status: true, id: Number(id) };
    }
    const newId = await callKw(b, MODEL, 'create', [vals]);
    return { status: true, id: newId };
  } catch (e) {
    log.warn('save failed', e?.message);
    return { status: false, message: e?.message || 'Could not save the reminder.' };
  }
}

// Tick it off. The SERVER owns what that means — it writes the history row with
// the name and time snapshotted, then either advances a repeating reminder to its
// next date or switches a one-shot off. Never reimplement that here: the repeat
// arithmetic has to exist in exactly one language or the two will disagree about
// what "+1 day, same wall-clock time" means across a DST change.
export async function completeReminder(id) {
  const b = await base();
  if (!b) return { status: false, message: 'No server connection' };
  try {
    await callKw(b, MODEL, 'action_complete', [[Number(id)]]);
    return { status: true };
  } catch (e) {
    log.warn('complete failed', e?.message);
    return { status: false, message: e?.message || 'Could not complete the reminder.' };
  }
}

export async function deleteReminder(id) {
  const b = await base();
  if (!b) return { status: false, message: 'No server connection' };
  try {
    await callKw(b, MODEL, 'unlink', [[Number(id)]]);
    return { status: true };
  } catch (e) {
    log.warn('delete failed', e?.message);
    return { status: false, message: e?.message || 'Could not delete the reminder.' };
  }
}

// Past completions, newest first. The rows snapshot the name and the due time, so
// history stays readable after its reminder is deleted — which is exactly when
// reminder_id is null, hence no filter on it here.
export async function fetchReminderHistory(limit = 100) {
  const b = await base();
  if (!b) return { status: false, message: 'No server connection' };
  try {
    const rows = await callKw(b, 'kpi.reminder.completion', 'search_read',
      [[], ['name_snapshot', 'time_snapshot', 'completed_at', 'reminder_id']],
      { order: 'completed_at desc, id desc', limit });
    return { status: true, rows: Array.isArray(rows) ? rows : [] };
  } catch (e) {
    log.info('history failed', e?.message);
    return { status: false, rows: [], message: e?.message || 'Unavailable' };
  }
}
