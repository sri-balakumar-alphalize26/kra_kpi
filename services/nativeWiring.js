// Native wiring that must happen AFTER the app has drawn its first frame.
//
// Called from a mount effect on the root <App/> (App.js), which React runs only
// after the first commit. Not from index.js at module scope, and not from a
// setTimeout(0) there either: the standalone build hung on the splash while
// native work ran during module evaluation, and a setTimeout(0) can still fire
// before React's first commit on a slow device. A mount effect is the only hook
// guaranteed to come after the frame that lifts the native splash.
//
// Expo Go has none of these native modules, so every step here is a no-op there
// -- which is exactly why the same JS ran fine in Expo Go while the APK hung.
import { boot } from '../utils/bootTrace';
import Notifications from './lazyNotifications';
import { createLogger } from '../api/logger';

const log = createLogger('App');

let wired = false;

// Show a banner + add to the tray even when the app is foregrounded.
//
// This lived at App.js's module scope, which meant expo-notifications loaded
// during module evaluation — the thing that hung the standalone build. Setting
// the handler one frame later is harmless: it only matters once a notification
// arrives, which cannot happen before the app has drawn.
function setForegroundNotificationHandler() {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        // Diagnostic: proves a (local or push) notification actually FIRED while
        // the app is foregrounded — the reminder alarm should log here when its
        // timer hits.
        log.info('notification received (foreground)', {
          title: notification?.request?.content?.title,
          data: notification?.request?.content?.data,
        });
        return {
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        };
      },
    });
    boot('native: notification handler set');
  } catch (e) {
    console.log('[Notif] setNotificationHandler failed', e?.message);
  }
}

// Notifee REQUIRES a background event handler or it drops alarm events when the
// app is backgrounded/killed. Its docs want this at the JS entry; registering it
// one frame later is the price of an app that starts. The cost: a background
// event arriving in the first moments of a cold start could be missed.
function registerNotifeeBackgroundHandler() {
  try {
    // eslint-disable-next-line global-require
    const notifee = require('@notifee/react-native').default;
    notifee.onBackgroundEvent(async ({ type, detail }) => {
      // Trace only (visible via `adb logcat`) -- the full-screen intent launches
      // the app and App.js reads getInitialNotification() to show the alarm screen.
      console.log('[Alarm bg] event', type, detail?.notification?.id);
    });
    boot('native: notifee background handler registered');
  } catch (e) {
    // Report the error, not an assumed cause. A catch like this once relabelled
    // a stack overflow as "module unavailable" and cost a day.
    console.log('[Alarm bg] notifee registration failed — skipped', e?.message);
    if (e?.stack) console.log('[Alarm bg] stack', String(e.stack).slice(0, 2000));
  }
}

/** Idempotent: the root can remount (an ErrorBoundary reset) without re-registering. */
export function wireNativeIntegrations() {
  if (wired) return;
  wired = true;
  boot('native: wiring started');
  setForegroundNotificationHandler();
  registerNotifeeBackgroundHandler();
  boot('native: wiring done');
}
