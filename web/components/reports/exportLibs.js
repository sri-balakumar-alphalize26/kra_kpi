/* The browser-side export libraries, loaded on demand so they never weigh on
   a page that does not export. Versions are pinned in package.json to the ones
   the Odoo module loads from cdnjs (jsPDF 2.5.1 + AutoTable 3.5.31, JSZip 3.10.1,
   ExcelJS 4.4.0), so a file built here matches one built in Odoo. */

export async function loadPdf() {
  const [jsp, at] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const jsPDF = jsp.jsPDF || jsp.default?.jsPDF || jsp.default;
  let autoTable = at.default;
  if (typeof autoTable !== "function") autoTable = autoTable?.default || at.autoTable;
  if (typeof jsPDF !== "function" || typeof autoTable !== "function") throw new Error("The PDF library did not load. Refresh the page and try again.");
  /* doc.autoTable(opts), as the Odoo screens call it; also sets doc.lastAutoTable. */
  const make = (...args) => {
    const doc = new jsPDF(...args);
    if (typeof doc.autoTable !== "function") doc.autoTable = (opts) => autoTable(doc, opts);
    return doc;
  };
  return { jsPDF, autoTable, make };
}

export async function loadExcel() {
  const mod = await import("exceljs");
  const ExcelJS = mod.Workbook ? mod : mod.default;
  if (!ExcelJS?.Workbook) throw new Error("The spreadsheet library did not load. Refresh the page and try again.");
  return ExcelJS;
}

export async function loadZip() {
  const mod = await import("jszip");
  const JSZip = mod.default || mod;
  if (typeof JSZip !== "function") throw new Error("The ZIP library did not load. Refresh the page and try again.");
  return JSZip;
}

/* Hand a Blob to the browser as a download. */
export function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = fileName || "download";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* Blob → base64 (no data: prefix), for download_save. */
export function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}
