// Standalone reminders, armed on the device.
//
// Until this existed you could create a reminder and it would simply never fire.
// The Reminders screen said so, and blamed the notifee rebuild — but notifee is
// only needed for the LOOPING FULL-SCREEN alarm (services/alarm.js). A banner
// with sound needs expo-notifications, which is in every installed build and is
// already doing this job for per-task reminders in services/reminders.js. So the
// feature was reachable the whole time; it just had not been wired up.
//
// What this gives: a heads-up notification with sound on the shared 'reminders'
// channel, at the right moment, tappable through to the Reminders screen.
//
// A reminder rings the same way a task alarm does WHEN notifee is present:
// full-screen, looping, with Stop and Snooze. When it is not, the same reminder
// still arrives as a heads-up banner with sound. That fallback is not a
// nice-to-have -- services/alarm.js guards its own import and no-ops without the
// native module, so without a fallback a reminder on such a build would fire
// nothing at all, silently.
//
// What it does NOT give, and why:
//   * After a reboot, BANNERS come back on their own: expo-notifications ships a
//     boot receiver (its AndroidManifest asks for RECEIVE_BOOT_COMPLETED and
//     re-schedules its triggers). Notifee ALARMS are re-armed by the next sync,
//     which App.js runs on every foreground — so an alarm due before the app is
//     next opened after a reboot arrives as nothing. Known; no native code here.
//   * A reminder created on the WEB arms only when this device next syncs. The
//     server never pushes for reminders — kpi_reminder.py's own docstring calls
//     that "deliberately not built yet".
//   * Only the next occurrence of a repeat is armed. The server advances
//     remind_date in action_complete, so until one is completed there is no later
//     instant to schedule.
import Notifications from './lazyNotifications';
import { createLogger } from '../api/logger';
import { ensureReminderChannel, cancelTaskReminder } from './reminders';
import { getReminderAlarms, saveReminderAlarms, pruneReminderSnoozes,
         getReminderModes, getReminderSnoozes, setReminderSnooze,
         getReminders, clearReminders } from '../api/session';
import { alarmAvailable, scheduleTaskAlarm, stopAlarm } from './alarm';
// The two decisions that can be silently wrong -- what the server's naive-UTC
// string means, and which rows deserve an alarm -- live in utils/ as pure
// functions so they unit-test without a device. This module only schedules.
import { armableReminders } from '../utils/reminderSchedule';

const log = createLogger('ReminderAlarm');

/**
 * Make this device's scheduled notifications match `rows` (the server's list).
 *
 * Cheap to call often: an unchanged reminder is left alone rather than cancelled
 * and re-created, so repeated syncs do not churn the OS's timer list.
 */
// One sync at a time. The foreground handler in App.js and the Reminders
// screen's load both call this, and a notification tap fires both at once:
// each read the saved map, saw no alarm, scheduled one, and whichever wrote
// last won — the other alarm was orphaned, rang as a duplicate, and Stop could
// only silence one. Queued, the second run sees the first run's map.
let syncChain = Promise.resolve();

export function syncReminderAlarms(rows, uid) {
  const run = syncChain.then(() => syncReminderAlarmsNow(rows, uid));
  syncChain = run.catch(() => {});
  return run;
}

async function syncReminderAlarmsNow(rows, uid) {
  try {
    const now = Date.now();
    const want = armableReminders(rows, now);
    const prev = await getReminderAlarms(uid);
    const next = {};

    // A snoozed reminder is armed for a time the SERVER knows nothing about, so
    // it looks exactly like a stale entry to the reconcile below -- which would
    // cancel it, usually within one 15s sync. Snoozes are held separately and
    // skipped here; pruning drops the ones whose time has already passed.
    const snoozed = await pruneReminderSnoozes(uid, now);

    // What the OS actually still holds. The stored map can outlive the schedule
    // it describes -- a reinstall, cleared data, or a notification that already
    // fired -- and without this check we would believe an id that is long gone
    // and never re-arm it.
    let live = new Set();
    try {
      const all = await Notifications.getAllScheduledNotificationsAsync();
      live = new Set((all || []).map((n) => n.identifier));
    } catch (e) {
      // Treat "cannot tell" as "all still live" rather than re-arming the lot:
      // a duplicate ring is worse than a missed re-arm we will retry next sync.
      live = new Set(Object.values(prev || {}).map((v) => v && v.notifId).filter(Boolean));
    }

    const channelId = await ensureReminderChannel();
    let armed = 0;
    let cancelled = 0;

    // Ring properly if we can. alarmAvailable() is a runtime answer, not a build
    // assumption -- the codebase long claimed notifee was dead in every shipped
    // build while the installed APK in fact carried it.
    //
    // This is now only the CAPABILITY. Which of the two a given reminder actually
    // gets is the owner's choice (getReminderModes), because once a build ships
    // with notifee, "can ring" would otherwise mean "always rings" and a reminder
    // wanted as a quiet nudge takes over the screen.
    const canRing = alarmAvailable();
    const modes = await getReminderModes(uid);

    for (const r of want) {
      // Leave a snoozed reminder exactly as it is.
      if (snoozed[r.id]) { next[r.id] = prev[r.id] || snoozed[r.id]; continue; }

      const was = prev[r.id];
      const whenIso = new Date(r.at).toISOString();
      // What this reminder SHOULD be, given its owner's choice and what this
      // build can do. 'alarm' asked for on a build without notifee still degrades
      // to a banner -- better a banner than silence.
      const wantKind = (modes[r.id] === 'notify') ? 'banner' : (canRing ? 'alarm' : 'banner');
      // Already scheduled for this exact instant, and the OS agrees it exists.
      // Only meaningful for the banner path: a notifee alarm is not in expo's
      // scheduled list, so `live` cannot vouch for it and `was.kind` is checked
      // instead.
      //
      // `wanted === wantKind` is load-bearing. Switching a reminder between
      // Notify and Alarm does NOT change its time, so without this the row reads
      // as unchanged, the old scheduling survives, and the reminder keeps firing
      // the way it used to -- or fires twice, once from each mechanism.
      //
      // Compared against what was ASKED for, not what was armed: an alarm that
      // degraded to a banner (permission refused) is stored as kind 'banner',
      // and comparing that with a wanted 'alarm' tore the banner down and
      // re-armed it on every sync — plus a permission prompt each time.
      if (was && was.whenIso === whenIso && was.notifId && (was.wanted || was.kind) === wantKind
          && (was.kind === 'alarm' || live.has(was.notifId))) {
        next[r.id] = was;
        continue;
      }
      if (was && was.notifId) {
        try {
          if (was.kind === 'alarm') await stopAlarm(was.notifId);
          else await Notifications.cancelScheduledNotificationAsync(was.notifId);
        } catch (_) {}
      }

      if (wantKind === 'alarm') {
        const notifId = await scheduleTaskAlarm(
          { kind: 'reminder', id: r.id, name: r.name }, r.at, '');
        if (notifId) {
          next[r.id] = { notifId, whenIso, kind: 'alarm', wanted: 'alarm' };
          armed += 1;
          continue;
        }
        // Fell through: scheduleTaskAlarm returns null on a refused permission or
        // a non-Android platform. Better a banner than silence.
        log.info('alarm refused, falling back to a banner', { id: r.id });
      }

      try {
        const notifId = await Notifications.scheduleNotificationAsync({
          content: {
            title: '⏰ Reminder',
            body: r.name,
            sound: 'default',
            // reminder_id, and deliberately NO kpi_id: App.js routes a tap by
            // looking for invoice_id, then report_id, then falls through to
            // routeToTask(kpi_id). A payload carrying a stray kpi_id would open
            // somebody's task instead of the reminder.
            data: { reminder_id: Number(r.id) },
          },
          // DATE, not the TIME_INTERVAL services/reminders.js uses: that one is
          // relative because a task reminder means "in N minutes", whereas this
          // is a real instant the server computed. The explicit `type` matters --
          // without it expo silently schedules a channel-only trigger that never
          // fires (see the warning in services/reminders.js).
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date: new Date(r.at),
            channelId,
          },
        });
        next[r.id] = { notifId, whenIso, kind: 'banner', wanted: wantKind };
        armed += 1;
      } catch (e) {
        log.warn('arm failed', { id: r.id, error: e?.message });
      }
    }

    // Anything we had armed that is no longer wanted -- deleted, switched off,
    // moved, or already fired.
    for (const [id, v] of Object.entries(prev || {})) {
      if (next[id]) continue;
      if (v && v.notifId) {
        try {
          if (v.kind === 'alarm') await stopAlarm(v.notifId);
          else await Notifications.cancelScheduledNotificationAsync(v.notifId);
          cancelled += 1;
        } catch (_) {}
      }
    }
    // A SNOOZED reminder that is no longer wanted (deleted or switched off while
    // snoozed). Its snooze alarm has an id of its own, held only in the snooze
    // map, so cancelling the original above left the snooze to ring anyway.
    for (const [id, v] of Object.entries(snoozed || {})) {
      if (next[id]) continue;
      try {
        if (v && v.notifId) await stopAlarm(v.notifId);
        await setReminderSnooze(id, null, uid);
        cancelled += 1;
      } catch (_) {}
    }

    await saveReminderAlarms(uid, next);
    // `canRing` is the capability, not the outcome: each reminder now picks its
    // own kind, so report how many chose Notify rather than one mode for the lot.
    log.info('sync', { wanted: want.length, armed, cancelled, kept: want.length - armed,
                      canRing, notify: Object.values(modes).filter((m) => m === 'notify').length,
                      snoozed: Object.keys(snoozed).length });
    return { armed, cancelled, total: want.length };
  } catch (e) {
    log.warn('sync failed', e?.message);
    return null;
  }
}

// Drop every armed reminder. For logout: the next user on this device must not
// inherit somebody else's notifications.
export async function clearReminderAlarms(uid) {
  try {
    const prev = await getReminderAlarms(uid);
    for (const v of Object.values(prev || {})) {
      if (v && v.notifId) {
        try {
          if (v.kind === 'alarm') await stopAlarm(v.notifId);
          else await Notifications.cancelScheduledNotificationAsync(v.notifId);
        } catch (_) {}
      }
    }
    await saveReminderAlarms(uid, {});
    // Snoozes too: each holds its own alarm id, and a snoozed reminder used to
    // outlive the sign-out and ring for the next person, with this user's text.
    const snoozes = await getReminderSnoozes(uid);
    for (const [id, v] of Object.entries(snoozes || {})) {
      try {
        if (v && v.notifId) await stopAlarm(v.notifId);
        await setReminderSnooze(id, null, uid);
      } catch (_) {}
    }
    log.info('cleared');
  } catch (e) {
    log.warn('clear failed', e?.message);
  }
}

// Drop every PER-TASK reminder (the board's bell: "remind me in 60 min"). For
// logout, like clearReminderAlarms: these are OS alarms and banners scheduled
// with this user's task names, and nothing used to cancel them, so the next
// person on the phone got a full-screen alarm for somebody else's task and a
// Stop button that opened it.
export async function clearTaskReminders() {
  try {
    const map = await getReminders();
    for (const rem of Object.values(map || {})) {
      if (!rem || !rem.notifId) continue;
      try {
        if (rem.mode === 'alarm') await stopAlarm(rem.notifId);
        else await cancelTaskReminder(rem.notifId);
      } catch (_) {}
    }
    await clearReminders();
    log.info('task reminders cleared', { count: Object.keys(map || {}).length });
  } catch (e) {
    log.warn('task reminder clear failed', e?.message);
  }
}
