// JS door onto the native widget bridge. See the Kotlin for why it exists.
//
// Loaded DEFENSIVELY, like @notifee/react-native is in services/alarm.js and
// App.js: this native module only exists in a build made after it was added, and
// a bare requireNativeModule throws at import time in Expo Go or on any older
// APK — which would take the whole app down at startup rather than degrade to the
// behaviour it already had.
// Resolved on FIRST USE, not at import.
//
// It used to run at module scope, and that turned out to matter: this file is
// reached during startup through App.js -> HomeScreen -> utils/taskWidget, so the
// lookup happened while modules were still being evaluated, before React had
// mounted anything. In Expo Go the require throws and is skipped, so the path is
// inert there; in a standalone build it actually runs. That asymmetry is the
// difference between the build that starts and the build that does not, and the
// app has no business touching native code before it can draw a frame.
//
// Nothing else changes: both functions below already funnel through one place, so
// the lookup simply happens the first time a widget refresh is asked for — by
// which point the app is long since running.
let native = null;
let resolved = false;

function getNative() {
  if (resolved) return native;
  resolved = true;
  try {
    // eslint-disable-next-line global-require
    const { requireNativeModule } = require('expo-modules-core');
    native = requireNativeModule('TaskWidgetBridge');
  } catch (_) {
    // Absent (Expo Go, or a build predating this module) — every call no-ops.
    native = null;
  }
  return native;
}

// The two providers the config plugins emit into the app's package. Simple class
// names — the native side prefixes the package itself.
const TASK = 'TaskWidgetProvider';
const LIVE_TRACKING = 'LiveTrackingWidgetProvider';

/** True when the native side is present, i.e. this build can redraw the widget. */
export function widgetBridgeAvailable() {
  return !!getNative();
}

// Every call below swallows everything and answers false on any doubt. A widget
// is an extra: "no bridge in this build", "no widget on the home screen" and "the
// provider does not exist" are all ordinary outcomes, not errors, and none of them
// may interrupt a task switch or a sign-in.
function call(fn, ...args) {
  const mod = getNative();
  if (!mod || typeof mod[fn] !== 'function') return false;
  try {
    return !!mod[fn](...args);
  } catch (_) {
    return false;
  }
}

/**
 * Ask Android to redraw a widget now.
 *
 * Returns true only if a widget was actually asked to repaint. False covers both
 * "this build has no bridge" and "the user has no widget on their home screen".
 */
export function refreshTaskWidget() {
  return call('refreshWidget', TASK);
}

export function refreshLiveTrackingWidget() {
  return call('refreshWidget', LIVE_TRACKING);
}

/**
 * Is this widget actually on a home screen?
 *
 * Used to skip work nobody will see — the Live Tracking widget costs an extra
 * admin-only RPC to feed, and most admins will never add it.
 */
export function taskWidgetPlaced() {
  return call('widgetPlaced', TASK);
}

export function liveTrackingWidgetPlaced() {
  return call('widgetPlaced', LIVE_TRACKING);
}

/**
 * Show or hide the Live Tracking widget in Android's widget picker.
 *
 * Android's picker knows nothing about who is signed in, and the route behind
 * this widget is admin-only — so without this a developer would find it on
 * long-press, add it, and get a permanently empty box that reads as a broken app.
 * The receiver ships disabled and is switched on only for an admin.
 */
export function setLiveTrackingWidgetEnabled(enabled) {
  return call('setWidgetEnabled', LIVE_TRACKING, !!enabled);
}

export default {
  widgetBridgeAvailable,
  refreshTaskWidget,
  refreshLiveTrackingWidget,
  taskWidgetPlaced,
  liveTrackingWidgetPlaced,
  setLiveTrackingWidgetEnabled,
};
