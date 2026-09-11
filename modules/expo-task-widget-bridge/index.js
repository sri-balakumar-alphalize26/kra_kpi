// JS door onto the native widget bridge. See the Kotlin for why it exists.
//
// Loaded DEFENSIVELY, like @notifee/react-native is in services/alarm.js and
// App.js: this native module only exists in a build made after it was added, and
// a bare requireNativeModule throws at import time in Expo Go or on any older
// APK — which would take the whole app down at startup rather than degrade to the
// behaviour it already had.
let native = null;
try {
  // eslint-disable-next-line global-require
  const { requireNativeModule } = require('expo-modules-core');
  native = requireNativeModule('TaskWidgetBridge');
} catch (_) {
  // Absent (Expo Go, or a build predating this module) — every call below no-ops.
}

/** True when the native side is present, i.e. this build can redraw the widget. */
export function widgetBridgeAvailable() {
  return !!native;
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
  if (!native) return false;
  try {
    return !!native.refreshWidget();
  } catch (_) {
    return false;
  }
}

export default { widgetBridgeAvailable, refreshTaskWidget };
