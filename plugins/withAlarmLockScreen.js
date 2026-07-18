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
        main.$['android:showWhenLocked'] = 'true';   // draw over the lock screen
        main.$['android:turnScreenOn'] = 'true';      // wake the screen when launched
      }
    }
    return cfg;
  });
};
