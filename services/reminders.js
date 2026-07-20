// Per-task reminder alarms — a developer sets "ping me in N minutes" on a task so
// they don't have to keep re-checking elapsed vs. estimate. Purely on-device: a
// local scheduled notification (banner + default sound). Tapping it opens the
// task (the notification carries data.kpi_id, which App.js's tap listener routes
// through routeToTask). No backend, no native rebuild — expo-notifications is
// already in the build and permission is granted at login.
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { createLogger } from '../api/logger';

const log = createLogger('Reminders');

// A dedicated high-importance channel so a fired reminder pops as a heads-up
// banner WITH sound + vibration (on Android 8+, sound/heads-up come from the
// channel, not content). Runtime call — no rebuild. Created once, idempotent.
async function ensureReminderChannel() {
  if (Platform.OS !== 'android') return undefined;
  try {
    await Notifications.setNotificationChannelAsync('reminders', {
      name: 'Task reminders',
      importance: Notifications.AndroidImportance.MAX,   // heads-up + sound
      sound: 'default',
      vibrationPattern: [0, 400, 250, 400],
      enableVibrate: true,
    });
    log.info('reminder channel ready', { channelId: 'reminders' });
    return 'reminders';
  } catch (e) {
    log.warn('channel setup failed', e?.message);
    return undefined;
  }
}

// Schedule a reminder `seconds` from now for `task`. Returns { notifId, whenIso }
// (null on failure / no permission). Reuses the 'default' Android channel that
// services/push.js already created.
export async function scheduleTaskReminder(task, seconds, reason = '') {
  try {
    const secs = Math.max(1, Math.round(seconds));
    const note = (reason || '').trim();
    log.info('schedule: requested', { task: task?.id, name: task?.name, seconds: secs, hasReason: !!note });
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      if (req.status !== 'granted') { log.warn('reminder: permission not granted'); return null; }
    }
    const name = task?.name || 'your task';
    const channelId = await ensureReminderChannel();
    const notifId = await Notifications.scheduleNotificationAsync({
      content: {
        title: '⏰ Time to wrap up',
        // Typed reason leads when present, else the default task line.
        body: note || `${name} — your set time is up.`,
        sound: 'default',
        data: { kpi_id: task?.id, reason: note },   // App.js tap listener → routeToTask(kpi_id)
      },
      // MUST carry an explicit `type`: without it, expo-notifications ignores
      // `seconds` and schedules a channel-only (no-fire) trigger. This typed
      // TIME_INTERVAL is what actually creates the timer.
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: secs,
        channelId,
      },
    });
    const whenIso = new Date(Date.now() + secs * 1000).toISOString();
    log.info('reminder scheduled', { task: task?.id, notifId, whenIso });
    return { notifId, whenIso };
  } catch (e) {
    log.warn('schedule failed', e?.message);
    return null;
  }
}

// Cancel a previously scheduled reminder. Safe to call with a stale/missing id.
export async function cancelTaskReminder(notifId) {
  if (!notifId) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(notifId);
    log.info('reminder cancelled', { notifId });
  } catch (e) {
    log.warn('cancel failed', e?.message);
  }
}
