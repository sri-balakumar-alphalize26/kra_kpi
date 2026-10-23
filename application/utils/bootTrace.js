// Boot markers, for finding out where startup stops.
//
// WHY console.log AND NOT api/logger's log.info: info is gated on __DEV__, so
// in the release build that matters it prints nothing. console.log always
// reaches logcat as I/ReactNativeJS.
//
// WHY THIS EXISTS. The 1.3.0 build never drew a frame. Not a crash — the JS
// thread sat at 106% CPU with minutes of CPU time, so something loops forever
// during startup. A release APK is not debuggable: no Hermes profiler, no
// thread dump (`kill -3` is refused), and an infinite loop logs nothing at all.
// Rendering the splash in jest does not reproduce it, with the SVG mock or with
// the real library.
//
// So the build itself has to say how far it got. Each marker prints once with
// the milliseconds since the previous one; the LAST marker in logcat is the
// line the app never got past, and the gap before it is where the time went.
//
// Read them with:
//   adb logcat | grep BOOT
//
// Cheap enough to leave in: a handful of console.log calls on paths that run
// once. Remove them only once startup is trusted again.
let t0 = 0;
let last = 0;
const seen = new Set();

export function boot(marker, once = true) {
  try {
    const now = Date.now();
    if (!t0) { t0 = now; last = now; }
    // Render markers would otherwise print on every re-render and drown the log
    // — and a marker repeating IS itself the finding, so count instead of spam.
    if (once) {
      if (seen.has(marker)) return;
      seen.add(marker);
    }
    const sinceStart = now - t0;
    const sincePrev = now - last;
    last = now;
    console.log(`[BOOT] ${marker} +${sincePrev}ms (t=${sinceStart}ms)`);
  } catch (_) {
    // A diagnostic must never be the thing that breaks startup.
  }
}

// For anything that may run many times: prints the first 5, then every 50th, so
// a render loop shows up as a rising count rather than an unreadable flood.
const counts = new Map();
export function bootTick(marker) {
  try {
    const n = (counts.get(marker) || 0) + 1;
    counts.set(marker, n);
    if (n <= 5 || n % 50 === 0) console.log(`[BOOT] ${marker} #${n}`);
  } catch (_) {}
}
