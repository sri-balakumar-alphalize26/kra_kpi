/* PDF and Word (.docx) downloads of 369 AI Assistant answers (AiAssistant.jsx).
   A download is a list of sections — { question, res } — so one answer and a
   whole chat share the same builders. `res` is the /kra_kpi/ai_assistant answer:
   title, blocks (stats / table / list / text), date_range.
   PDF: jsPDF + AutoTable; Word: a minimal real .docx zipped with JSZip — both
   loaded on demand through exportLibs, so nothing new is installed. */
import { loadPdf, loadZip, saveBlob } from "@/components/reports/exportLibs";

const BRAND = [30, 64, 175];
const BRAND_HEX = "1E40AF";

const cell = (v) => (v === "" || v == null ? "-" : String(v));
const fmtDay = (d) => { if (!d) return ""; const x = new Date(`${d}T00:00:00`); return isNaN(x) ? d : x.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); };
const fmtRange = (r) => (!r ? "" : r.start === r.end ? fmtDay(r.start) : `${fmtDay(r.start)} - ${fmtDay(r.end)}`);
const isWide = (sections) => sections.some((s) => (s.res?.blocks || []).some((b) => b.type === "table" && (b.columns || []).length >= 7));
const exportable = (res) => res && res.intent !== "smalltalk" && (res.blocks || []).length > 0;

/* jsPDF's built-in fonts are Latin-1 only: map the symbols the answers use. */
const pdfText = (s) => String(s ?? "")
  .replace(/[·•]/g, "-").replace(/[–—]/g, "-").replace(/…/g, "...").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/₹/g, "Rs ").replace(/[✓✔]/g, "").replace(/[^\x00-\xFF]/g, "?");

const slug = (s) => String(s || "answer").replace(/[\\/:*?"<>|]+/g, " ").replace(/[^\w\s.-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "answer";
/* Local date and time for file names: DDMMYY_HHMM, e.g. 191026_1349. */
const stamp = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}${p(d.getMonth() + 1)}${p(d.getFullYear() % 100)}_${p(d.getHours())}${p(d.getMinutes())}`;
};
const nowText = () => new Date().toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

/* ------------------------------------------------------------------ PDF */
async function buildPdf(sections, meta) {
  const { make } = await loadPdf();
  const doc = make({ orientation: isWide(sections) ? "landscape" : "portrait", unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 40;
  let y = M;
  const ensure = (h) => { if (y + h > H - M - 14) { doc.addPage(); y = M; } };
  const lines = (txt, size, style = "normal", color = 20, indent = 0) => {
    doc.setFont("helvetica", style); doc.setFontSize(size); doc.setTextColor(color);
    const ls = doc.splitTextToSize(pdfText(txt), W - 2 * M - indent);
    for (const l of ls) { ensure(size + 4); doc.text(l, M + indent, y + size * 0.8); y += size + 4; }
  };

  doc.setFont("helvetica", "bold"); doc.setFontSize(17); doc.setTextColor(...BRAND); doc.text("369 AI Assistant", M, y + 12); y += 22;
  lines(`${meta.subtitle}  -  generated ${nowText()}${meta.user ? ` by ${meta.user}` : ""}`, 9, "normal", 110);
  doc.setDrawColor(...BRAND); doc.setLineWidth(1.2); doc.line(M, y + 2, W - M, y + 2); y += 16;

  sections.forEach((s, idx) => {
    const r = s.res || {};
    if (s.question) lines(`Question: ${s.question}`, 10, "bold", 90);
    if (r.title) { y += 2; lines(r.title, 13, "bold", 20); }
    const range = fmtRange(r.date_range);
    if (range) lines(`Period: ${range}`, 9, "normal", 120);
    y += 4;
    for (const b of r.blocks || []) {
      if (b.type === "stats") {
        ensure(50);
        doc.autoTable({
          startY: y, margin: { left: M, right: M, bottom: M + 14 }, theme: "grid",
          head: [(b.items || []).map((i) => pdfText(i.label))], body: [(b.items || []).map((i) => pdfText(cell(i.value)))],
          styles: { fontSize: 8.5, cellPadding: 4, halign: "center", valign: "middle" },
          headStyles: { fillColor: [238, 242, 255], textColor: [55, 65, 81], fontStyle: "bold" },
          bodyStyles: { fontStyle: "bold", fontSize: 11, textColor: 20 },
        });
        y = doc.lastAutoTable.finalY + 10;
      } else if (b.type === "table") {
        ensure(60);
        const cols = b.columns || [];
        doc.autoTable({
          startY: y, margin: { left: M, right: M, top: M, bottom: M + 14 }, theme: "striped",
          head: [cols.map((c) => pdfText(c.label))],
          body: (b.rows || []).map((row) => cols.map((c) => pdfText(cell(row[c.key])))),
          styles: { fontSize: 8.5, cellPadding: 3.5, overflow: "linebreak", valign: "top" },
          headStyles: { fillColor: BRAND, textColor: 255, fontStyle: "bold" },
          columnStyles: Object.fromEntries(cols.map((c, i) => [i, c.kind === "num" ? { halign: "right" } : c.kind === "task" ? { cellWidth: "auto", minCellWidth: 130 } : {}])),
        });
        y = doc.lastAutoTable.finalY + 8;
        if (b.more > 0) lines(`+${b.more} more rows not included.`, 8.5, "italic", 120);
      } else if (b.type === "list") {
        if (b.title) lines(b.title.toUpperCase(), 9, "bold", 100);
        for (const it of b.items || []) lines(`-  ${it}`, 10, "normal", 30, 6);
        y += 4;
      } else if (b.text) {
        lines(b.text, 10.5, "normal", 30); y += 4;
      }
    }
    if (idx < sections.length - 1) { y += 6; ensure(20); doc.setDrawColor(215); doc.setLineWidth(0.6); doc.line(M, y, W - M, y); y += 16; }
  });

  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i); doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(150);
    doc.text(`369 AI Assistant  -  page ${i} of ${n}`, W - M, H - 18, { align: "right" });
  }
  return doc.output("blob");
}

/* ----------------------------------------------------------------- Word */
const esc = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const run = (t, { b, i, sz, color } = {}) =>
  `<w:r><w:rPr>${b ? "<w:b/>" : ""}${i ? "<w:i/>" : ""}${color ? `<w:color w:val="${color}"/>` : ""}${sz ? `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` : ""}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const para = (runs, { style, after = 100, indent } = {}) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}<w:spacing w:after="${after}"/>${indent ? `<w:ind w:left="${indent}"/>` : ""}</w:pPr>${runs}</w:p>`;
const tcell = (text, { head, fill, bold, right } = {}) =>
  `<w:tc><w:tcPr>${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ""}</w:tcPr><w:p><w:pPr><w:spacing w:after="0"/>${right ? '<w:jc w:val="right"/>' : ""}</w:pPr>${run(text, { b: head || bold, sz: 18, color: head ? "FFFFFF" : undefined })}</w:p></w:tc>`;
const BORDERS = '<w:tblBorders>' + ["top", "left", "bottom", "right", "insideH", "insideV"].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="C9D2E3"/>`).join("") + "</w:tblBorders>";
const table = (head, rows, { rightCols = [], headFill = BRAND_HEX, boldBody } = {}) =>
  `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${BORDERS}<w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
  `<w:tblGrid>${head.map(() => "<w:gridCol/>").join("")}</w:tblGrid>` +
  `<w:tr><w:trPr><w:tblHeader/></w:trPr>${head.map((h) => tcell(h, { head: headFill === BRAND_HEX, fill: headFill, bold: true })).join("")}</w:tr>` +
  rows.map((r, ri) => `<w:tr>${r.map((v, ci) => tcell(v, { fill: ri % 2 ? "F5F7FB" : undefined, right: rightCols.includes(ci), bold: boldBody })).join("")}</w:tr>`).join("") +
  "</w:tbl>" + para("", { after: 120 });

async function buildDocx(sections, meta) {
  const JSZip = await loadZip();
  const body = [];
  body.push(para(run("369 AI Assistant", { b: true, sz: 34, color: BRAND_HEX }), { after: 40 }));
  body.push(para(run(`${meta.subtitle}  ·  generated ${nowText()}${meta.user ? ` by ${meta.user}` : ""}`, { sz: 18, color: "6B7280" }), { after: 240 }));
  sections.forEach((s, idx) => {
    const r = s.res || {};
    if (s.question) body.push(para(run("Question: ", { b: true, sz: 20, color: "6B7280" }) + run(s.question, { sz: 20, color: "374151" }), { after: 60 }));
    if (r.title) body.push(para(run(r.title, { b: true, sz: 26 }), { style: "Heading2", after: 60 }));
    const range = fmtRange(r.date_range);
    if (range) body.push(para(run(`Period: ${range}`, { sz: 18, color: "6B7280" }), { after: 120 }));
    for (const b of r.blocks || []) {
      if (b.type === "stats") {
        body.push(table((b.items || []).map((i) => i.label), [(b.items || []).map((i) => cell(i.value))], { headFill: "EEF2FF", boldBody: true }));
      } else if (b.type === "table") {
        const cols = b.columns || [];
        body.push(table(cols.map((c) => c.label), (b.rows || []).map((row) => cols.map((c) => cell(row[c.key]))),
          { rightCols: cols.map((c, i) => (c.kind === "num" ? i : -1)).filter((i) => i >= 0) }));
        if (b.more > 0) body.push(para(run(`+${b.more} more rows not included.`, { i: true, sz: 18, color: "6B7280" })));
      } else if (b.type === "list") {
        if (b.title) body.push(para(run(b.title.toUpperCase(), { b: true, sz: 18, color: "6B7280" }), { after: 40 }));
        for (const it of b.items || []) body.push(para(run(`•  ${it}`, { sz: 21 }), { after: 40, indent: 240 }));
      } else if (b.text) {
        body.push(para(run(b.text, { sz: 21 }), { after: 140 }));
      }
    }
    if (idx < sections.length - 1) body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D1D5DB"/></w:pBdr><w:spacing w:after="240"/></w:pPr></w:p>');
  });
  const wide = isWide(sections);
  const sect = `<w:sectPr>${wide ? '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>' : '<w:pgSz w:w="11906" w:h="16838"/>'}<w:pgMar w:top="900" w:right="800" w:bottom="900" w:left="800" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr>`;
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/_rels/document.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="111827"/></w:rPr></w:style></w:styles>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body.join("")}${sect}</w:body></w:document>`);
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

/* --------------------------------------------------------------- public */
export { exportable };

/* kind: "pdf" | "docx"; sections: [{ question, res }]; meta: { user, subtitle, name } */
export async function downloadSections(kind, sections, meta) {
  const list = sections.filter((s) => exportable(s.res));
  if (!list.length) throw new Error("There is nothing to download yet.");
  const blob = kind === "pdf" ? await buildPdf(list, meta) : await buildDocx(list, meta);
  saveBlob(blob, `369-AI-${slug(meta.name || list[0].res.title)}-${stamp()}.${kind}`);
}
