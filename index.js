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

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
