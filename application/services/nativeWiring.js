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

// Stop expo-notifications registering the device token with EXPO'S servers.
//
// THIS IS THE 70-SECOND STALL. DevicePushTokenAutoRegistration runs when
// expo-notifications is imported: it posts the device's FCM token to
// exp.host/--/api/v2/push/updateDeviceToken and, on failure, retries with
// backoff until the budget runs out -- measured at 70.2s and 69.4s on the
// tablet, near identical across runs because it is a fixed budget, not a random
// spin. It then throws `TypeError: Object is not a constructor` out of a promise
// chain dozens deep, which React Native escalates to a native FATAL EXCEPTION
// and the app dies. Startup went from seconds to 140 seconds and a crash.
//
// It fails because the EAS project changed on 9 Sep (71d2cf0: projectId
// bd95e45c -> 1c193ac9, owner donav -> vavinix) while google-services.json still
// points at Firebase project kra-kpi-3efd5, so Expo's servers reject the
// registration.
//
// But the honest point is that the app never needed it. Push tokens are
// registered with ODOO, by services/push.js on login, through /kpi_push/register
// -- Expo's own device-token bookkeeping is redundant here and always was. This
// is expo-notifications' own supported switch for turning it off, and it
// persists, so it stays off on later launches too.
async function disableExpoServerAutoRegistration() {
  try {
    await Notifications.setAutoServerRegistrationEnabledAsync(false);
    boot('native: expo auto-registration disabled');
  } catch (e) {
    // Not fatal: if this fails the app still runs, it just pays the retry again.
    console.log('[Notif] could not disable auto server registration', e?.message);
  }
}

/**
 * Idempotent: the root can remount (an ErrorBoundary reset) without re-wiring.
 *
 * Each step is isolated and none may block the others. They run after the first
 * frame, but "after" is not enough on its own -- a single slow native call here
 * held up everything behind it, which is how one failing registration delayed
 * the whole app.
 */
export function wireNativeIntegrations() {
  if (wired) return;
  wired = true;
  boot('native: wiring started');
  setForegroundNotificationHandler();
  registerNotifeeBackgroundHandler();
  // Deliberately not awaited: it talks to the network and nothing below or after
  // depends on it.
  disableExpoServerAutoRegistration();
  boot('native: wiring done');
}
