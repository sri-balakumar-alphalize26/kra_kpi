// The document libraries — jsPDF, jspdf-autotable, JSZip, ExcelJS — loaded ON
// DEMAND, the first time a report is actually generated.
//
// WHY NOT AT IMPORT. These are multi-megabyte, Node-shaped libraries with heavy
// module-scope initialisation (ExcelJS alone drags in readable-stream and a
// hundred-odd uses of process.nextTick). Until this file existed, the three
// report utils imported them at module scope, and App.js imports those utils'
// screens eagerly — so every one of them evaluated at app startup, before the
// first frame, for a user who had merely opened the app. That is the exact set
// of dependencies that arrived between the last build that started normally
// (1.1.0, 22 Aug) and the first that did not: startup went from seconds to
// three minutes of the JS thread at 100% CPU, and the device's error frames land
// in jsPDF's module. Nobody needs a PDF engine to reach the login screen.
//
// Nothing about the documents changes. Same libraries, same code that draws
// them, one `require` later — the first Generate after opening the app pays a
// moment to load them, and after that they are cached.
//
// ORDER IS LOAD-BEARING, in two places:
//   1. installNodeShims() must run BEFORE the libraries are required. They read
//      `Buffer` and `process` off the global at THEIR module scope; mapping the
//      module names in metro.config.js is not enough on its own.
//   2. jspdf-autotable must be required AFTER jspdf: it patches jsPDF.API on
//      import and has no export of its own.
import { installNodeShims } from '../shims';

let libs = null;

/** Returns { jsPDF, JSZip, ExcelJS }. Idempotent; the work happens once. */
export function loadReportLibs() {
  if (libs) return libs;
  installNodeShims();
  /* eslint-disable global-require */
  const { jsPDF } = require('jspdf');
  require('jspdf-autotable');
  const JSZip = require('jszip');
  const ExcelJS = require('exceljs');
  /* eslint-enable global-require */
  libs = { jsPDF, JSZip, ExcelJS };
  return libs;
}
