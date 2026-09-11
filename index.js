// FIRST, before anything else: installs the Buffer/process globals that ExcelJS
// and JSZip read at module scope. See shims.js and metro.config.js.
import './shims';

import { registerRootComponent } from 'expo';

import App from './App';

// Notifee REQUIRES a background event handler registered at the JS entry (module
// scope) or it drops alarm events when the app is backgrounded/killed. But notifee
// is a NATIVE module: before the one-time rebuild, even importing it throws and
// would crash the app at launch. So load it DEFENSIVELY — once the native side is
// present (post-rebuild) this registers the handler; until then it's a harmless
// no-op. Routing to the full-screen Stop UI is done in App.js.
try {
  const notifee = require('@notifee/react-native').default;
  notifee.onBackgroundEvent(async ({ type, detail }) => {
    // Trace only (visible via `adb logcat`) — the full-screen intent launches the
    // app and App.js reads getInitialNotification() to show the alarm screen.
    console.log('[Alarm bg] event', type, detail?.notification?.id);
  });
} catch (e) {
  // notifee native module not present yet (needs a rebuild) — skip registration.
  console.log('[Alarm bg] notifee unavailable — skipped', e?.message);
}

// A data-only push arriving while the app is CLOSED. Registered at module scope
// for the same reason as the notifee handler above: the task has to exist before
// the runtime looks for it, and there is no component mounted to do it later.
//
// Why this is needed at all. Until now the app could only react to a notification
// when somebody TAPPED it (addNotificationResponseReceivedListener in App.js) —
// nothing could run with the app closed. That is fine for "here is a message",
// and useless for "a reminder was just created on the web": the phone has to hear
// about it in order to arm its own offline alarm for the right second. Pushing
// when the row is WRITTEN rather than when it is DUE is the whole design, and it
// only works if something can receive that push unattended.
//
// Defensive like everything else here: expo-task-manager is native, so this is
// inert in Expo Go and on any build predating it.
export const BG_NOTIFICATION_TASK = 'kra-kpi-bg-notification';
try {
  const TaskManager = require('expo-task-manager');
  const Notifications = require('expo-notifications');

  TaskManager.defineTask(BG_NOTIFICATION_TASK, ({ data, error }) => {
    if (error) {
      console.log('[BG push] task error', error?.message);
      return;
    }
    // Trace only for now. Arming a reminder alarm from here is deliberately a
    // separate change: it needs a discriminator threaded through the alarm
    // payload and its routing, and none of that can be tested until a build with
    // notifee in it actually exists. Landing the receiving end first means the
    // next step has somewhere to land.
    console.log('[BG push] received', JSON.stringify(data || {}));
  });

  Notifications.registerTaskAsync(BG_NOTIFICATION_TASK)
    .then(() => console.log('[BG push] task registered'))
    .catch((err) => console.log('[BG push] register failed', err?.message));
} catch (e) {
  console.log('[BG push] expo-task-manager unavailable — skipped', e?.message);
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
