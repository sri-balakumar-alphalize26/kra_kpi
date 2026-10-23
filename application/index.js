// The Buffer/process globals for ExcelJS and JSZip used to be installed here, as
// the very first import. They are now installed by utils/reportLibs.js at the
// moment a report is generated, right before those libraries are required. See
// shims.js for why that move mattered to startup.
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

      // In a release build the buck stops here: do NOT pass this on.
      //
      // RN's default handler reports the error through ExceptionsManager, which
      // kills the process -- `FATAL EXCEPTION: mqt_native_modules`. That is how
      // a failed background push registration, which the user never asked for
      // and cannot see, took the whole app down. It also died a second way on
      // the way out: OutOfMemoryError inside JSStackTrace.format, because the
      // stack it was formatting was a promise chain dozens of frames deep.
      //
      // An app that survives a background error is strictly better than one that
      // dies showing nothing. Render errors are unaffected -- ErrorBoundary owns
      // those and is the right mechanism for them.
      //
      // In DEV, still pass it on: the red box is how a developer finds these at
      // all, and losing it would trade one silence for another.
      const isDev = typeof __DEV__ !== 'undefined' && __DEV__;
      if (isDev && prev) { try { prev(err, isFatal); } catch (_) {} }
    });
  }
} catch (_) {}

import { registerRootComponent } from 'expo';

import App from './App';

boot('index: App module imported');

// NO native module is touched in this file. That is a rule, not a tidy-up.
//
// The standalone 1.3.0 build never got past the splash: the JS thread pinned at
// ~106% CPU, React never mounted, and expo-splash-screen -- which lifts the
// native splash only on the first frame -- left it up forever. The same JS ran
// fine in Expo Go under `expo start --no-dev --minify`, where the native modules
// this file used to touch simply do not exist. So the fault was never the
// JavaScript; it was native work running before the app could draw.
//
// What used to be here, and where it went:
//
//   * notifee's background event handler -- now services/nativeWiring.js, called
//     from a mount effect on the root <App/> so it runs only after the first
//     commit. (Not a setTimeout(0) here: on a slow device that can fire before
//     React's first frame, which puts native work straight back in front of it.)
//
//   * A background task for data-only pushes arriving with the app closed
//     (expo-task-manager + Notifications.registerTaskAsync) -- REMOVED, dependency
//     and all. It was trace-only, it is in the exact native delta between the last
//     working build (1.1.0, 22 Aug) and the first hanging one, it errored on the
//     device in both builds that produced logs, and its native TaskService
//     re-registers persisted tasks before any JS runs. Nothing functional is lost.
//     The design it served -- "the phone hears about a reminder the moment the row
//     is written on the web, so it can arm an offline alarm" -- still needs a
//     mechanism when it is picked up again; whatever that is, it must not do
//     native work during module evaluation.

// registerRootComponent calls AppRegistry.registerComponent('main', () => App).
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately.
boot('index: calling registerRootComponent');
try {
  registerRootComponent(App);
  boot('index: registerRootComponent returned');
} catch (e) {
  // This call is where the app's root is handed to AppRegistry. Nothing may
  // come before it that can hang.
  console.log('[FATAL] registerRootComponent threw: ' + (e && e.message));
  if (e && e.stack) console.log('[FATAL] stack ' + String(e.stack).slice(0, 3000));
  throw e;
}
