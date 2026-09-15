// Metro config exists for ONE reason: the KRA Report builds its own PDF, Excel
// and ZIP on the device, using the same four libraries the Odoo web screen loads
// from a CDN (jsPDF, jspdf-autotable, JSZip, ExcelJS).
//
// Three of those are Node-shaped. They `require('buffer')`, `require('stream')`
// and `require('process')`, none of which React Native ships, and Metro fails the
// bundle rather than guessing — so the bare names are pointed at the browser
// shims here. The matching GLOBALS are installed by shims.js's installNodeShims(),
// which utils/reportLibs.js calls immediately before requiring the libraries —
// mapping the module names is not enough on its own, because these libraries
// read `Buffer` and `process` off the global at module scope. (It used to run
// from index.js at startup; see shims.js for why it moved.)
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  // The trailing slash matters: it forces the npm package rather than Node's
  // own builtin, which is what a bare 'buffer' resolves to under the toolchain.
  buffer: require.resolve('buffer/'),
  stream: require.resolve('stream-browserify'),
  process: require.resolve('process/browser'),
};

module.exports = config;
