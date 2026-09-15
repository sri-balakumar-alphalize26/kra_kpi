// Full-screen ringing alarm for task reminders (Android, via @notifee). Unlike the
// notification reminder, this LOOPS the sound and takes over the screen until the
// user taps Stop — a real alarm. Needs the native @notifee module (a rebuild).
//
// Flow: scheduleTaskAlarm() schedules an exact AlarmManager trigger notification with
// a full-screen action; when it fires the OS launches the app full-screen (even on
// the lock screen) and loops the sound. App.js routes to AlarmScreen, whose Stop
// button calls stopAlarm() to cancel it (which stops the loop).
import { Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
// The alarm CHANNEL is created through expo-notifications, not notifee — see
// ensureAlarmChannel below for why. notifee still posts the notification.
// Lazy: importing expo-notifications at module scope starts a promise chain in
// its own module body, which hung the standalone build. See services/lazyNotifications.js.
import Notifications from './lazyNotifications';

// The enums come off the same lazy module. They were named imports, which would
// have loaded it at import time and defeated the point; all three are only ever
// read inside ensureAlarmChannel(), so a getter is enough.
const ExpoImportance = { get MAX() { return Notifications.AndroidImportance.MAX; } };
const ExpoVisibility = { get PUBLIC() { return Notifications.AndroidNotificationVisibility.PUBLIC; } };
const AndroidAudioUsage = { get ALARM() { return Notifications.AndroidAudioUsage.ALARM; } };
import { createLogger } from '../api/logger';
import { getAlarmSound, getAlarmSettings } from '../api/session';

const log = createLogger('Alarm');

// Load notifee DEFENSIVELY. It's a native module, and in a build that doesn't yet
// bundle its native side (i.e. before the one-time rebuild) merely importing it
// throws 'Notifee native module not found.' at module-eval time — which would crash
// the whole app at launch. A guarded require() turns that into a catchable no-op:
// the app keeps running and every call below simply falls through until the rebuild
// lands the native module.
let notifee = null;
// AndroidVisibility is gone from this list on purpose: lockscreen visibility now
// travels with the channel, which expo-notifications creates (ExpoVisibility).
let AndroidImportance = {}, AndroidCategory = {}, TriggerType = {}, AuthorizationStatus = {};

// Loaded on FIRST USE, not at import.
//
// The require used to sit at module scope. That is fine in Expo Go, where it
// throws and is skipped, but in a standalone build it actually pulls in and
// initialises a native module WHILE MODULES ARE STILL BEING EVALUATED — before
// React has mounted anything and before a single frame has been drawn. That
// asymmetry is exactly the difference between the build that starts and the one
// that hangs on the splash, so no native work happens here at import any more.
//
// Every entry point below already gates on notifee being present, so they call
// this first and nothing else changes. The constants are filled in at the same
// time; they are only ever read inside those same functions.
let notifeeTried = false;
function loadNotifee() {
  if (notifeeTried) return notifee;
  notifeeTried = true;
  try {
    // eslint-disable-next-line global-require
    const nf = require('@notifee/react-native');
    notifee = nf.default;
    AndroidImportance = nf.AndroidImportance;
    AndroidCategory = nf.AndroidCategory;
    TriggerType = nf.TriggerType;
    AuthorizationStatus = nf.AuthorizationStatus;
    log.info('notifee loaded (native module present)');
  } catch (e) {
    notifee = null;
    log.warn('notifee unavailable — alarm disabled until the app is rebuilt', e?.message);
  }
  return notifee;
}

// Bumped from 'task-alarm' when the channel moved to the ALARM audio stream.
// A channel's audio attributes are frozen at creation exactly like its sound, so
// every device already carrying a 'task-alarm::*' channel would have kept ringing
// on the NOTIFICATION stream forever. Changing the prefix abandons all of them at
// once — including the custom-sound `u<hash>` ones, which a soundKey()-only bump
// would have missed.
const CHANNEL_ID = 'task-alarm-v2';
const VIBRATION = [300, 500, 300, 500];

// The device's default ALARM ringtone. Passing 'default' as a notifee channel
// sound gives the default NOTIFICATION sound (a short chime) — which is exactly
// why alarms were ringing like a notification. This system URI is what
// RingtoneManager.getDefaultUri(TYPE_ALARM) resolves to, so an alarm with no
// custom sound chosen rings the real alarm tone instead.
const DEFAULT_ALARM_URI = 'content://settings/system/alarm_alert';

// A notifee channel's sound is IMMUTABLE once created, so each distinct chosen
// sound needs its own channel id. Derive a short, stable key from the sound URI
// ('default' when none is chosen) → channel id `task-alarm::<key>`.
function soundKey(sound) {
  const uri = sound?.uri;
  // 'alarmdef' (not 'default') so devices that already made the old notification-
  // sound channel get a NEW channel carrying the alarm sound — a channel's sound
  // is immutable once created, so the key must change to take effect.
  if (!uri) return 'alarmdef';
  let h = 0;
  for (let i = 0; i < uri.length; i++) h = ((h << 5) - h + uri.charCodeAt(i)) | 0;
  return 'u' + (h >>> 0).toString(36);
}

// Android returns a CANONICAL ringtone URI with the display name embedded as a
// `title` query param, e.g. content://media/internal/audio/media/49?title=Homecoming&canonical=1
// → "Homecoming". Pull it out so we can show the real sound name (no native needed).
export function titleFromUri(uri) {
  if (!uri) return null;
  try {
    const m = /[?&]title=([^&]+)/.exec(uri);
    if (m) return decodeURIComponent(m[1].replace(/\+/g, ' '));
  } catch (_) {}
  return null;
}

// True only once notifee's native module is present (after the rebuild). Callers
// use this to fall back to the plain notification reminder in the meantime.
export function alarmAvailable() {
  return !!loadNotifee();
}

// Ask for notification permission (Android 13+) and, on Android, prompt to allow
// full-screen intents / exact alarms if the OS is withholding them.
export async function ensureAlarmPermission() {
  if (!loadNotifee()) return false;
  try {
    const settings = await notifee.requestPermission();
    const granted = settings.authorizationStatus >= AuthorizationStatus.AUTHORIZED;
    // authorizationStatus: 0=denied, 1=authorized, 2=provisional. If not granted,
    // the OS will suppress the alarm — this log is the first place to look.
    log.info('permission', { authorizationStatus: settings?.authorizationStatus, granted });
    return granted;
  } catch (e) {
    log.warn('permission failed', e?.message);
    return false;
  }
}

// Create the alarm channel for a given chosen `sound` (idempotent). MAX importance
// + ALARM category so it rings loud and can bypass Do-Not-Disturb. One channel per
// sound (see soundKey) because a channel's sound can't change after creation.
//
// Created via EXPO-NOTIFICATIONS, not notifee, for one reason: audioAttributes.
// notifee's AndroidChannel type has no field for them at all (only `sound`), so a
// notifee-made channel lands on the default NOTIFICATION stream — which meant the
// alarm went silent whenever notification volume was 0, leaving vibration only,
// and made bypassDnd meaningless. usage: ALARM puts it on the alarm stream, so it
// behaves like the clock app: independent of notification volume.
//
// Channels are app-global, so notifee happily posts to a channel someone else
// created; it only needs the id back. The notification-mode reminder
// (services/reminders.js) is unaffected and keeps the normal notification sound.
async function ensureAlarmChannel(sound) {
  if (!loadNotifee()) return undefined;
  const channelId = `${CHANNEL_ID}::${soundKey(sound)}`;
  const soundVal = sound?.uri || DEFAULT_ALARM_URI;   // chosen content:// URI, or the default ALARM tone
  await Notifications.setNotificationChannelAsync(channelId, {
    name: 'Task alarms',
    importance: ExpoImportance.MAX,
    sound: soundVal,
    audioAttributes: { usage: AndroidAudioUsage.ALARM },
    vibrationPattern: VIBRATION,
    enableVibrate: true,
    bypassDnd: true,
    lockscreenVisibility: ExpoVisibility.PUBLIC,
    showBadge: false,
  });
  // Read back rather than trust the write: `sound` is the one field that can be
  // rejected (Android resolves it against res/raw on some paths), and a channel
  // that silently landed with no sound is precisely the bug being fixed here.
  try {
    const ch = await Notifications.getNotificationChannelAsync(channelId);
    log.info('channel ready', {
      channelId, sound: soundVal, title: sound?.title,
      readBackSound: ch?.sound, usage: ch?.audioAttributes?.usage,
    });
    if (ch && !ch.sound) {
      log.warn('alarm channel has NO sound — it will only vibrate', { channelId, requested: soundVal });
    }
  } catch (e) {
    log.warn('channel read-back failed', e?.message);
  }
  return channelId;
}

// What an alarm is ABOUT. Tasks were the only answer for a long time, so the
// whole path -- payload, routing, snooze, the Stop screen -- reads `task`. A
// standalone reminder rings the same way but is not a task and carries no
// kpi_id: that absence is deliberate, it is what makes a reminder's tap open the
// Reminders screen instead of somebody's task.
//
// Rather than thread a second parallel branch through four files, everything now
// speaks `subject`: { kind: 'task' | 'reminder', id, name }. Callers that still
// pass a bare task object keep working -- asSubject() normalises them.
export function asSubject(x) {
  if (!x) return { kind: 'task', id: '', name: '' };
  if (x.kind === 'task' || x.kind === 'reminder') return x;
  return { kind: 'task', id: x.id, name: x.name || '' };   // legacy: a task
}

// Schedule a ringing alarm for `whenMs` (epoch ms). Returns the notification id
// (persist it so it can be cancelled), or null on failure / non-Android / no notifee.
//
// `subjectIn` is a subject as above, or a plain task for older callers.
export async function scheduleTaskAlarm(subjectIn, whenMs, reason = '') {
  const task = asSubject(subjectIn);
  if (Platform.OS !== 'android') { log.info('schedule skipped (not android)', { platform: Platform.OS }); return null; }
  if (!loadNotifee()) { log.warn('schedule skipped — notifee unavailable (rebuild needed)', { subject: task?.id }); return null; }
  try {
    const note = (reason || '').trim();
    const secsFromNow = Math.round((whenMs - Date.now()) / 1000);
    // Read the chosen system sound HERE (not via a param) so snooze — which
    // re-schedules from only {id,name} — automatically rings the same sound.
    const sound = await getAlarmSound();
    const soundVal = sound?.uri || DEFAULT_ALARM_URI;   // default ALARM tone, not the notification chime
    // ringMins: how long it rings before the OS auto-cancels it (0 = until Stop).
    const { ringMins } = await getAlarmSettings();
    log.info('schedule: requested', { task: task?.id, name: task?.name, whenMs, secsFromNow, sound: soundVal, soundTitle: sound?.title, ringMins });
    const granted = await ensureAlarmPermission();
    if (!granted) log.warn('schedule: permission not granted — alarm may be suppressed', { task: task?.id });
    const channelId = await ensureAlarmChannel(sound);
    const notifId = await notifee.createTriggerNotification(
      {
        title: task.kind === 'reminder' ? '⏰ Reminder' : '⏰ Time to wrap up',
        // The typed reason leads when present, else the subject's own name.
        body: note || task?.name || (task.kind === 'reminder' ? 'Your reminder' : 'Your task'),
        // kpi_id ONLY for a task. A reminder carries reminder_id instead, so the
        // tap lands on the Reminders screen -- App.js routes on whichever is
        // present, and a stray kpi_id here would open an unrelated task.
        data: {
          ...(task.kind === 'reminder'
            ? { reminder_id: String(task?.id ?? '') }
            : { kpi_id: String(task?.id ?? '') }),
          alarm: '1',
          subject_kind: task.kind,
          task_name: task?.name || '',
          reason: note,
        },
        android: {
          channelId,
          category: AndroidCategory.ALARM,
          importance: AndroidImportance.HIGH,
          loopSound: true,      // ring continuously…
          ongoing: true,        // …and stay until dismissed…
          autoCancel: false,    // …not dismissed by a tap
          sound: soundVal,      // chosen system sound (content:// URI) or default
          vibrationPattern: VIBRATION,
          // Auto-stop the ring after ringMins (OS cancels it). 0 = ring until Stop.
          ...(ringMins > 0 ? { timeoutAfter: ringMins * 60000 } : {}),
          fullScreenAction: { id: 'alarm', launchActivity: 'default' },
          pressAction: { id: 'alarm', launchActivity: 'default' },
        },
      },
      {
        type: TriggerType.TIMESTAMP,
        timestamp: whenMs,
        alarmManager: { allowWhileIdle: true },   // fire even in Doze / battery saver
      },
    );
    log.info('alarm scheduled', { task: task?.id, notifId, whenMs, secsFromNow, sound: soundVal });
    return notifId;
  } catch (e) {
    log.warn('schedule failed', e?.message);
    return null;
  }
}

// Open the phone's own system ringtone picker (Alarm type) and return the chosen
// { uri, title } — or null if cancelled. Android only; the caller persists it via
// setAlarmSound so scheduleTaskAlarm can read it back. Uses expo-intent-launcher
// (no custom native module): the picked content:// URI comes back as a string in
// result.extra under EXTRA_RINGTONE_PICKED_URI.
export async function pickAlarmSound(current) {
  if (Platform.OS !== 'android') return null;
  try {
    log.info('sound: opening ringtone picker', { current: current?.uri || 'default' });
    const result = await IntentLauncher.startActivityAsync(
      'android.intent.action.RINGTONE_PICKER',
      {
        extra: {
          'android.intent.extra.ringtone.TYPE': 4,            // RingtoneManager.TYPE_ALARM
          'android.intent.extra.ringtone.TITLE': 'Select alarm sound',
          'android.intent.extra.ringtone.SHOW_DEFAULT': true,
          'android.intent.extra.ringtone.SHOW_SILENT': false,
        },
      },
    );
    // Log the RAW result so we can see exactly what the picker returned on this
    // device/runtime (the URI arrives in `extra`, not `data`).
    log.info('sound: picker result', { resultCode: result?.resultCode, extra: result?.extra, data: result?.data });
    if (result?.resultCode !== -1) { log.info('sound: picker cancelled'); return null; }  // -1 = RESULT_OK
    const extra = result?.extra || {};
    let uri = extra['android.intent.extra.ringtone.PICKED_URI'];
    // Defensive fallback: some builds surface the picked URI via result.data.
    if (!uri && typeof result?.data === 'string' && result.data.startsWith('content://')) uri = result.data;
    if (uri === undefined) uri = null;
    // The canonical URI embeds the real display name — use it; fall back to a
    // generic label only if it's somehow absent.
    const name = titleFromUri(uri);
    const sound = { uri, title: name || (uri ? 'Custom alarm sound' : 'Default alarm') };
    log.info('sound: picked', { uri, title: sound.title });
    return sound;
  } catch (e) {
    log.warn('sound: picker failed', e?.message);
    return null;
  }
}

// Stop a ringing/scheduled alarm — cancels the notification, which stops the loop.
export async function stopAlarm(notifId) {
  if (Platform.OS !== 'android' || !notifId) return;
  if (!loadNotifee()) { log.warn('stop skipped — notifee unavailable', { notifId }); return; }
  log.info('stop: requested', { notifId });
  try {
    await notifee.cancelNotification(notifId);
    log.info('alarm stopped', { notifId });
  } catch (e) {
    log.warn('stop failed', e?.message);
  }
}
