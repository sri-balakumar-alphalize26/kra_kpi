// FIRST, before anything else: installs the Buffer/process globals that ExcelJS
// and JSZip read at module scope. See shims.js and metro.config.js.
import './shims';
import { boot } from './utils/bootTrace';

boot('index: shims loaded');

// Print what the runtime would otherwise swallow.
//
// Metro's guardedLoadModule wraps every module factory: if one throws, the
// error goes to ErrorUtils.reportFatalError and the require RETURNS NORMALLY.
// In a release build that is close to invisible -- no crash, no red box, and
// the app simply never registers its root component, so React never mounts and
// expo-splash-screen keeps the native splash up forever. Exactly the symptom
// the 1.3.0 build shows, and exactly why logcat had nothing to say.
//
// Installed FIRST, before anything that can throw, and it chains to whatever
// handler was already there so normal reporting is unchanged.
try {
  const EU = global.ErrorUtils;
  if (EU && typeof EU.setGlobalHandler === 'function') {
    const prev = typeof EU.getGlobalHandler === 'function' ? EU.getGlobalHandler() : null;
    EU.setGlobalHandler((err, isFatal) => {
      try {
        console.log('[FATAL] ' + (isFatal ? 'fatal' : 'non-fatal') + ': ' + (err && err.message));
        if (err && err.stack) console.log('[FATAL] stack ' + String(err.stack).slice(0, 3000));
      } catch (_) {}
      if (prev) { try { prev(err, isFatal); } catch (_) {} }
    });
  }
} catch (_) {}


import { registerRootComponent } from 'expo';

import App from './App';

boot('index: App module imported');

// Notifee REQUIRES a background event handler registered at the JS entry or it
// drops alarm events when the app is backgrounded/killed. But it is a NATIVE
// module, and it must not be touched while modules are still being evaluated --
// see the deferred wiring at the bottom of this file for why that distinction
// decides whether this build starts at all.
function registerNotifeeBackgroundHandler() {
  try {
    const notifee = require('@notifee/react-native').default;
    notifee.onBackgroundEvent(async ({ type, detail }) => {
      // Trace only (visible via `adb logcat`) -- the full-screen intent launches
      // the app and App.js reads getInitialNotification() to show the alarm screen.
      console.log('[Alarm bg] event', type, detail?.notification?.id);
    });
    boot('native: notifee background handler registered');
  } catch (e) {
    // The stack matters. This catch was written for one cause ("the module is not
    // in this build") and will happily swallow any other, reporting a crash as a
    // missing dependency. The 1.3.0 build did exactly that with its sibling: a
    // RangeError was logged as "expo-task-manager unavailable".
    console.log('[Alarm bg] notifee registration failed — skipped', e?.message);
    if (e?.stack) console.log('[Alarm bg] stack', String(e.stack).slice(0, 2000));
  }
}

// A data-only push arriving while the app is CLOSED. The task has to exist
// before the runtime looks for it, so it is registered from the entry file
// rather than from a component -- but on a later tick, not during module
// evaluation.
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

function registerBackgroundPushTask() {
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
      // payload and its routing.
      console.log('[BG push] received', JSON.stringify(data || {}));
    });

    Notifications.registerTaskAsync(BG_NOTIFICATION_TASK)
      .then(() => console.log('[BG push] task registered'))
      .catch((err) => console.log('[BG push] register failed', err?.message));
    boot('native: background push task registered');
  } catch (e) {
    // Same warning as the notifee catch above: do not describe the cause, report
    // it. This exact line said "expo-task-manager unavailable" while the real
    // error was 'Maximum call stack size exceeded'.
    console.log('[BG push] registration failed — skipped', e?.message);
    if (e?.stack) console.log('[BG push] stack', String(e.stack).slice(0, 2000));
  }
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
boot('index: calling registerRootComponent');
try {
  registerRootComponent(App);
  boot('index: registerRootComponent returned');
} catch (e) {
  // This call is where the app's root is handed to AppRegistry. Nothing may
  // come before it that can hang, which is the whole point of the deferral
  // below.
  console.log('[FATAL] registerRootComponent threw: ' + (e && e.message));
  if (e && e.stack) console.log('[FATAL] stack ' + String(e.stack).slice(0, 3000));
  throw e;
}

// Native wiring happens AFTER the root is registered, on a later tick.
//
// WHY, and it is the reason this build exists: with these two registrations at
// module scope the standalone APK never drew a frame. The JS thread pinned at
// 106% CPU, React never mounted, and expo-splash-screen -- which lifts the
// native splash only on the first frame -- left the splash up forever. The same
// JS runs fine in Expo Go under `expo start --no-dev --minify`, because there
// these native modules are ABSENT and both blocks are skipped. So the fault was
// never the JavaScript; it was native work running during module evaluation.
//
// setTimeout(0) rather than a microtask: it yields to the event loop, so
// AppRegistry can run the application and get a frame up first. Both callees
// swallow their own errors, and neither is on the path to drawing anything.
//
// The cost of deferring: a notifee background event or a data-only push
// arriving in the first moments of a cold start could be missed. That is a far
// better trade than an app that does not start, and the background push task is
// trace-only today in any case.
setTimeout(() => {
  boot('native: wiring started');
  registerNotifeeBackgroundHandler();
  registerBackgroundPushTask();
  boot('native: wiring done');
}, 0);