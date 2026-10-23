// Node globals that ExcelJS and JSZip expect. metro.config.js maps the MODULE
// names ('buffer', 'stream', 'process'); this fills in the GLOBALS, which those
// libraries read at module scope — so mapping alone leaves you with a bundle
// that builds and then throws "Buffer is not defined" the first time a workbook
// is written.
//
// This used to run at module scope as the very first line of index.js. It no
// longer does, and the reason is startup: installing these globals is cheap, but
// it was the front of a chain that pulled every document library into app
// startup, three minutes of JS thread before the first frame. Now
// utils/reportLibs.js calls installNodeShims() immediately before requiring the
// libraries — the same ordering, just at the moment a report is generated
// instead of the moment the app opens. Order is still load-bearing; it has only
// moved.
//
// The `buffer` package is required inside the function for the same reason:
// this module is still imported at the top of utils/reportLibs.js, which the
// report utils import at the top, which eager screens import — so anything at
// THIS module's scope still runs at app startup. Only the function body is
// deferred.

let installed = false;

export function installNodeShims() {
  if (installed) return;
  installed = true;

  // eslint-disable-next-line global-require
  const { Buffer } = require('buffer');
  if (typeof global.Buffer === 'undefined') global.Buffer = Buffer;

  // React Native already defines a minimal `process`. Fill in only what is
  // missing rather than replacing it — a wholesale swap drops process.env, which
  // RN and Expo both populate and read.
  const p = (global.process = global.process || {});
  if (!p.env) p.env = {};
  if (!p.version) p.version = 'v18.0.0';
  if (!p.versions) p.versions = { node: '18.0.0' };
  if (typeof p.nextTick !== 'function') {
    p.nextTick = (fn, ...args) => setTimeout(() => fn(...args), 0);
  }
  p.browser = true;
}
