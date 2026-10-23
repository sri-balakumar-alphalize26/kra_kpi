// Expo config plugin: allow the app's MainActivity to appear OVER the lock screen
// and turn the screen ON when it's launched by the alarm's full-screen intent
// (services/alarm.js → notifee fullScreenAction). Without these flags the alarm
// would fire behind the keyguard and you'd have to unlock to see the Stop screen.
// Applied at prebuild/EAS-build time; needs the dev-build rebuild to take effect.
const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withAlarmLockScreen(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application && cfg.modResults.manifest.application[0];
    if (app && Array.isArray(app.activity)) {
      const main = app.activity.find((a) => {
        const name = (a.$ && a.$['android:name']) || '';
        return name === '.MainActivity' || name.endsWith('.MainActivity');
      });
      if (main && main.$) {
        // These apply to the WHOLE activity (it is the app's only one), so
        // App.js switches them off at start through the bridge module and
        // AlarmScreen switches them on only while it rings — otherwise every
        // screen was visible, and usable, on a locked phone. The manifest
        // flags stay so a cold start FROM the alarm still draws over the keyguard.
        main.$['android:showWhenLocked'] = 'true';   // draw over the lock screen
        main.$['android:turnScreenOn'] = 'true';      // wake the screen when launched
      }
    }
    // SCHEDULE_EXACT_ALARM is the pre-Android-13 way to ask for exact alarms;
    // USE_EXACT_ALARM (also declared in app.json) is the 13+ one. Declaring
    // both without a ceiling makes Android 13+ show a "may schedule alarms"
    // permission the app never uses. Cap the old one at API 32.
    const perms = cfg.modResults.manifest['uses-permission'] || [];
    for (const p of perms) {
      if (p.$ && p.$['android:name'] === 'android.permission.SCHEDULE_EXACT_ALARM') {
        p.$['android:maxSdkVersion'] = '32';
      }
    }
    return cfg;
  });
};
