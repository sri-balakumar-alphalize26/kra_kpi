// expo-notifications, resolved on FIRST PROPERTY ACCESS instead of at import.
//
// WHY. Importing expo-notifications runs its module-scope side effects, and one
// of them starts a promise chain: DevicePushTokenAutoRegistration does
// `ServerRegistrationModule.getRegistrationInfoAsync().then(...)` while the
// module is still being evaluated. In a standalone build, where the native side
// is real, that chain ran away — the tablet showed the JS thread pinned at ~103%
// CPU straight after index.js returned, producing nothing, until it died with
// `RangeError: Maximum call stack size exceeded` whose stack was dozens of
// alternating `then` / `queueMicrotask` frames. React never got to render, so
// expo-splash-screen never lifted the native splash and the app hung on it. The
// identical JS is fine in Expo Go, where push is unavailable and that code never
// runs.
//
// So nothing in this app may import expo-notifications at module scope. Every
// use of it sits inside a function already, so deferring costs nothing: the
// module loads the first time something actually asks for a property, long after
// the app has drawn.
//
// A Proxy rather than a `getNotifications()` helper so the 23 existing call
// sites keep reading `Notifications.scheduleNotificationAsync(...)` unchanged —
// only the import line differs, which is a far smaller thing to get wrong.
//
// Destructuring this at module scope would defeat the whole point (it forces the
// load immediately). Read properties off it inside functions, as every caller
// already does.
let mod = null;

function load() {
  if (!mod) {
    // eslint-disable-next-line global-require
    mod = require('expo-notifications');
  }
  return mod;
}

const Notifications = new Proxy(
  {},
  {
    get(_target, prop) {
      const m = load();
      const value = m[prop];
      // Methods must keep their module as `this`.
      return typeof value === 'function' ? value.bind(m) : value;
    },
    has(_target, prop) {
      return prop in load();
    },
    ownKeys() {
      return Reflect.ownKeys(load());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const d = Reflect.getOwnPropertyDescriptor(load(), prop);
      // A Proxy may only report a non-configurable property if the target has
      // one, and our target is empty — so mark everything configurable.
      return d ? { ...d, configurable: true } : undefined;
    },
  }
);

export default Notifications;
