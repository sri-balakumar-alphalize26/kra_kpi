// Node globals that ExcelJS and JSZip expect, installed before anything imports
// them. metro.config.js maps the MODULE names ('buffer', 'stream', 'process');
// this fills in the GLOBALS, which those libraries read at module scope — so
// mapping alone leaves you with a bundle that builds and then throws
// "Buffer is not defined" the first time a workbook is written.
//
// Imported as the very first line of index.js. Order is load-bearing.
import { Buffer } from 'buffer';

if (typeof global.Buffer === 'undefined') global.Buffer = Buffer;

// React Native already defines a minimal `process`. Fill in only what is missing
// rather than replacing it — a wholesale swap drops process.env, which RN and
// Expo both populate and read.
const p = (global.process = global.process || {});
if (!p.env) p.env = {};
if (!p.version) p.version = 'v18.0.0';
if (!p.versions) p.versions = { node: '18.0.0' };
if (typeof p.nextTick !== 'function') {
  p.nextTick = (fn, ...args) => setTimeout(() => fn(...args), 0);
}
p.browser = true;
