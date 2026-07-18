// Expo config plugin: allow plain http:// (cleartext) traffic in the BUILT app.
// Android blocks cleartext by default in release/standalone/dev builds, so without
// this the built app can't reach an http:// Odoo server — every request fails and
// the app appears to "come out" (can't log in / load). It works in Expo Go only
// because Expo Go's own manifest permits cleartext. Mirrors the same fix used in the
// sibling Grocery_shop and tools-management apps. Applied at prebuild/EAS-build time.
const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application[0];
    application.$['android:usesCleartextTraffic'] = 'true';
    return cfg;
  });
};
