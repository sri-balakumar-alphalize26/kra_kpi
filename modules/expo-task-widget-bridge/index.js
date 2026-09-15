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

/** True when the native side is present, i.e. this build can redraw the widget. */
export function widgetBridgeAvailable() {
  return !!getNative();
}

/**
 * Ask Android to redraw the task widget now.
 *
 * Returns true only if a widget was actually asked to repaint. False covers both
 * "this build has no bridge" and "the user has no widget on their home screen" —
 * neither is an error, and neither should ever interrupt what the caller was
 * doing. Swallows everything for the same reason.
 */
export function refreshTaskWidget() {
  const mod = getNative();
  if (!mod) return false;
  try {
    return !!mod.refreshWidget();
  } catch (_) {
    return false;
  }
}

export default { widgetBridgeAvailable, refreshTaskWidget };
