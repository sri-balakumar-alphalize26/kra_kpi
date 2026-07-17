// Per-task reminder alarms — a developer sets "ping me in N minutes" on a task so
// they don't have to keep re-checking elapsed vs. estimate. Purely on-device: a
// local scheduled notification (banner + default sound). Tapping it opens the
// task (the notification carries data.kpi_id, which App.js's tap listener routes
// through routeToTask). No backend, no native rebuild — expo-notifications is
// already in the build and permission is granted at login.
import * as Notifications from 'expo-notifications';
import { createLogger } from '../api/logger';

const log = createLogger('Reminders');

// Schedule a reminder `seconds` from now for `task`. Returns { notifId, whenIso }
// (null on failure / no permission). Reuses the 'default' Android channel that
// services/push.js already created.
export async function scheduleTaskReminder(task, seconds) {
  try {
    const secs = Math.max(1, Math.round(seconds));
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      if (req.status !== 'granted') { log.warn('reminder: permission not granted'); return null; }
    }
    const name = task?.name || 'your task';
    const notifId = await Notifications.scheduleNotificationAsync({
      content: {
        title: '⏰ Time to wrap up',
        body: `${name} — your set time is up.`,
        sound: 'default',
        data: { kpi_id: task?.id },   // App.js tap listener → routeToTask(kpi_id)
      },
      trigger: { seconds: secs, channelId: 'default' },   // inexact interval → no exact-alarm permission
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
