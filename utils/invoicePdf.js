// The client invoice PDF, built ON THE DEVICE.
//
// A near-line-for-line port of downloadPdf() in the Odoo web screen
// (static/src/components/kpi_client_invoice/kpi_client_invoice.js), the same way
// utils/kraExport.js ports the KRA-report builders — and for the same reason: an
// invoice downloaded from the phone must BE the invoice downloaded from the
// browser, not a lookalike drawn by a second piece of code.
//
// It was a lookalike. That file says so itself:
//
//     "this invoice has TWO renderers — this one (jsPDF, in the browser) and
//      _build_invoice_pdf in kpi_reports_api.py (reportlab, used by the mobile
//      app). They must agree."
//
// They did not. The app fetched the reportlab one, which printed already-billed
// lines that its own total excluded (so the rows did not sum to the total),
// ignored the "Show amounts" toggle, and never printed Overall Notes. All three
// are things the browser's builder below has always done correctly.
//
// The data comes from /kpi_client_invoice/pdf_data — the exact route the browser
// calls, read-only, unchanged. Only the last step differs, as in kraExport.js:
//
//   web                     here
//   doc.save(name)          base64 + a filename, the caller writes the file
//
// Keep this in step with the web builder. If you change one, change both.

// jsPDF and jspdf-autotable are loaded on first use, not at import — see
// utils/reportLibs.js for why that is the difference between an app that starts
// in seconds and one that does not.
import { loadReportLibs } from './reportLibs';

// jsPDF hands back "data:application/pdf;filename=…;base64,XXXX"; everything
// downstream wants only the payload.
function docToB64(doc) {
  const uri = doc.output('datauristring');
  return uri.slice(uri.indexOf(',') + 1);
}

// jsPDF's default fonts only cover Latin-1. Glyphs like ₹ (INR) or ر.ع. (OMR)
// render as `&X&Y&Z` garbage, so fall back to the ASCII currency code.
function isAsciiSafe(str) {
  if (!str) return false;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 0x7F) return false;
  }
  return true;
}

// `pdf` is the payload from /kpi_client_invoice/pdf_data.
// `showAmounts` false = the cost-free delivery sheet, which the app has offered
// as a switch for a while with nothing behind it.
export function buildInvoicePdf(pdf, showAmounts = true) {
  const { jsPDF } = loadReportLibs();
  const inv = pdf.invoice || {};
  // Already-billed (locked) lines are excluded from the total, so drop them from
  // the printed line items too — otherwise the rows would not sum to the stated
  // total. This single line is the bug the app has been shipping.
  const pdfLines = (inv.lines || []).filter((l) => !l.already_invoiced);
  const showMoney = showAmounts !== false;
  const rate = inv.hourly_rate || 0;
  const cur = pdf.currency || { name: '', symbol: '', position: 'after', decimal_places: 2 };
  const dp = cur.decimal_places != null ? cur.decimal_places : 2;
  const safeCurToken = isAsciiSafe(cur.symbol) ? cur.symbol : (cur.name || '');
  const fmtMoney = (n) => {
    const s = (n || 0).toFixed(dp);
    if (safeCurToken) {
      return cur.position === 'before' ? `${safeCurToken}${s}` : `${s} ${safeCurToken}`;
    }
    return s;
  };

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setFont('times', 'normal');            // Times New Roman throughout
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 48;                              // uniform page margin
  let y = M;

  // Logo data + true aspect ratio (avoid stretching the logo).
  const logoData = pdf.company_logo_b64 ? ('data:image/png;base64,' + pdf.company_logo_b64) : '';
  let logoRatio = 1;   // width / height
  if (logoData) {
    try {
      const p = doc.getImageProperties(logoData);
      if (p && p.width && p.height) logoRatio = p.width / p.height;
    } catch (e) { /* keep 1:1 */ }
  }

  // Payment status shown next to the invoice number (and in the filename).
  const payLabel = inv.state === 'draft'
    ? ''
    : (inv.payment_status === 'paid'
      ? 'PAID'
      : (inv.client_paid_claim ? 'CLAIMED' : 'UNPAID'));
  // Red owed, amber claimed, green settled — the colours the screens already use,
  // so a printed copy carries the same signal as the list it came from.
  const payColor = payLabel === 'PAID' ? [21, 128, 61]
    : (payLabel === 'CLAIMED' ? [180, 83, 9] : [185, 28, 28]);

  // ── Header: logo left, company + INVOICE right ──
  if (logoData) {
    try {
      const h = 56, w = Math.min(h * logoRatio, 150);
      doc.addImage(logoData, 'PNG', M, y, w, h);
    } catch (e) { /* ignore bad image */ }
  }
  doc.setFont('times', 'bold'); doc.setFontSize(22);
  doc.text(pdf.company_name || '', pageW - M, y + 22, { align: 'right' });
  doc.setFont('times', 'normal'); doc.setFontSize(12);
  doc.text('INVOICE', pageW - M, y + 44, { align: 'right' });
  y += 72;
  doc.setDrawColor(190); doc.setLineWidth(0.8);
  doc.line(M, y, pageW - M, y);
  y += 22;

  // ── Meta: Invoice # (+ Paid/Unpaid) left, date right ──
  doc.setFontSize(11);
  doc.setFont('times', 'bold');
  doc.text(`Invoice #: ${inv.name}`, M, y);
  if (payLabel) {
    // Drawn separately so it can carry its own colour without tinting the number.
    const numW = doc.getTextWidth(`Invoice #: ${inv.name}`);
    doc.setTextColor(payColor[0], payColor[1], payColor[2]);
    doc.text(`   —   ${payLabel}`, M + numW, y);
    doc.setTextColor(0, 0, 0);
  }
  doc.setFont('times', 'normal');
  doc.text(`Date: ${inv.invoice_date}`, pageW - M, y, { align: 'right' });
  y += 17;
  if (inv.invoice_title) {
    doc.setFont('times', 'bold');
    doc.text(inv.invoice_title, M, y);
    doc.setFont('times', 'normal');
    y += 17;
  }
  doc.text(`Period: ${inv.from_date} to ${inv.to_date}`, M, y);
  if (showMoney && cur.name) {
    const symBit = isAsciiSafe(cur.symbol) ? ` (${cur.symbol})` : '';
    doc.text(`Currency: ${cur.name}${symBit}`, pageW - M, y, { align: 'right' });
  }
  y += 24;

  // ── Bill To (= root KRA) + Project (= sub-KRA) ──
  doc.setFont('times', 'bold'); doc.text('Bill To:', M, y);
  doc.setFont('times', 'normal'); y += 15;
  doc.setFont('times', 'bold'); doc.setFontSize(12);
  doc.text(pdf.bill_to_name || pdf.client_name || '', M, y);
  doc.setFont('times', 'normal'); doc.setFontSize(11);
  y += 15;
  if (pdf.project_name) {
    doc.text(`Project: ${pdf.project_name}`, M, y);
    y += 15;
  }
  y += 10;

  // Line items table — per_task shows a Type + Price column; hourly shows
  // Hours × Rate = Amount (the original layout).
  const isPerTask = inv.billing_method === 'per_task';
  const hasAmount = showMoney;   // "Show amounts" ON ⇒ money is shown (even at rate 0)
  let head, body;
  if (!showMoney) {
    // Clean, cost-free delivery sheet — tasks + hours (or type), no money.
    if (isPerTask) {
      head = [['Description', 'Type']];
      body = pdfLines.map((l) => {
        const desc = (l.line_type === 'adjustment' ? '[Adjustment] ' : '') + (l.description || '');
        const kind = (l.task_kind || '').toUpperCase() || (l.line_type === 'adjustment' ? 'ADJ' : '—');
        return [desc, kind];
      });
    } else {
      head = [['Description', 'Hours']];
      body = pdfLines.map((l) => {
        const desc = (l.line_type === 'adjustment' ? '[Adjustment] ' : '') + (l.description || '');
        return [desc, (l.quoted_hours || 0).toFixed(2)];
      });
    }
  } else if (isPerTask) {
    head = [['Description', 'Type', 'Price']];
    body = pdfLines.map((l) => {
      const desc = (l.line_type === 'adjustment' ? '[Adjustment] ' : '') + (l.description || '');
      const kind = (l.task_kind || '').toUpperCase() || (l.line_type === 'adjustment' ? 'ADJ' : '—');
      return [desc, kind, fmtMoney(l.unit_price || 0)];
    });
  } else {
    // Hourly + amounts on → always show Hours · Rate · Amount (rate may be 0).
    const rateHeader = `Rate (${fmtMoney(rate)})`;
    head = [['Description', 'Hours', rateHeader, 'Amount']];
    body = pdfLines.map((l) => {
      const desc = (l.line_type === 'adjustment' ? '[Adjustment] ' : '') + (l.description || '');
      const hours = (l.quoted_hours || 0).toFixed(2);
      const amt = fmtMoney((l.quoted_hours || 0) * rate);
      return [desc, hours, fmtMoney(rate), amt];
    });
  }

  // ── Line-items table — Description left/wide, every other column right-aligned. ──
  const colStyles = { 0: { halign: 'left', cellWidth: 'auto' } };
  for (let c = 1; c < head[0].length; c++) colStyles[c] = { halign: 'right', cellWidth: 92 };
  if (doc.autoTable) {
    doc.autoTable({
      startY: y,
      head,
      body,
      margin: { left: M, right: M },
      styles: { font: 'times', fontSize: 10, cellPadding: 6, lineColor: [225, 225, 225], lineWidth: 0.5, overflow: 'linebreak' },
      headStyles: { font: 'times', fontStyle: 'bold', fillColor: [56, 56, 92], textColor: 255, halign: 'left' },
      columnStyles: colStyles,
      alternateRowStyles: { fillColor: [247, 247, 251] },
    });
    y = doc.lastAutoTable.finalY + 18;
  } else {
    doc.setFont('times', 'bold');
    doc.text(head[0].join('   |   '), M, y); y += 14;
    doc.setFont('times', 'normal');
    body.forEach((row) => { doc.text(row.join('   |   '), M, y); y += 14; });
    y += 8;
  }

  // ── Totals (right-aligned to the same edge as the table) ──
  doc.setFont('times', 'bold'); doc.setFontSize(11);
  if (!isPerTask) {
    doc.text(`Total Hours: ${(inv.grand_total_hours || 0).toFixed(2)}`, pageW - M, y, { align: 'right' });
    y += 16;
  }
  if (hasAmount) {
    doc.setFontSize(13);
    const totalAmt = isPerTask ? (inv.total_amount || 0) : (inv.total_amount || (inv.grand_total_hours * rate));
    doc.text(`Total Amount: ${fmtMoney(totalAmt)}`, pageW - M, y, { align: 'right' });
    doc.setFontSize(11);
    y += 20;
  }

  // ── Notes ──
  if (inv.notes) {
    const plainNotes = (inv.notes || '').replace(/<[^>]+>/g, '').trim();
    if (plainNotes) {
      doc.setFont('times', 'bold'); doc.text('Notes:', M, y); y += 14;
      doc.setFont('times', 'normal');
      doc.text(doc.splitTextToSize(plainNotes, pageW - 2 * M), M, y);
    }
  }

  // ── Watermark: faint logo, centred on every page (drawn last, low opacity). ──
  // Best-effort on the web and best-effort here: this is the one part of the
  // builder kraExport.js never exercised, since the report draws no images. A
  // failure must cost the watermark, never the invoice.
  if (logoData) {
    try {
      let wmW = pageW * 0.55, wmH = wmW / (logoRatio || 1);
      if (wmH > pageH * 0.5) { wmH = pageH * 0.5; wmW = wmH * (logoRatio || 1); }
      const wmX = (pageW - wmW) / 2, wmY = (pageH - wmH) / 2;
      const pageCount = doc.internal.getNumberOfPages();
      for (let p = 1; p <= pageCount; p++) {
        doc.setPage(p);
        if (doc.GState) { doc.saveGraphicsState(); doc.setGState(new doc.GState({ opacity: 0.08 })); }
        doc.addImage(logoData, 'PNG', wmX, wmY, wmW, wmH);
        if (doc.GState) doc.restoreGraphicsState();
      }
    } catch (e) { /* watermark is best-effort */ }
  }

  return doc;
}

// The web's filename, built from the same two pieces: doc.save(
//   `${inv.name.replace(/\//g,'_')}${payLabel ? '_'+payLabel : ''}.pdf`)
export function invoiceFileName(pdf) {
  const inv = pdf.invoice || {};
  const payLabel = inv.state === 'draft'
    ? ''
    : (inv.payment_status === 'paid'
      ? 'PAID'
      : (inv.client_paid_claim ? 'CLAIMED' : 'UNPAID'));
  const base = String(inv.name || 'Invoice').replace(/\//g, '_');
  return `${base}${payLabel ? '_' + payLabel : ''}.pdf`;
}

// ── Deliverable: base64 + a filename, ready for the caller to save ──────────
// Same shape as makeReportPdf in utils/kraExport.js, and the same shape the
// screen's save/share paths already handle.
export function makeInvoicePdf(pdf, showAmounts = true) {
  return {
    status: true,
    file_name: invoiceFileName(pdf),
    mimeType: 'application/pdf',
    data_b64: docToB64(buildInvoicePdf(pdf, showAmounts)),
  };
}
