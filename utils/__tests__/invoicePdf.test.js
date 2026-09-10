// The client invoice PDF, which the app now builds itself.
//
// This is a port of the Odoo web builder, and the reason the port exists is that
// the app used to fetch a DIFFERENT renderer's output (reportlab, server-side)
// which disagreed with the browser's. So the tests pin the three things that
// disagreed — the ones a future edit would most easily undo.

const { buildInvoicePdf, invoiceFileName, makeInvoicePdf } = require('../invoicePdf');

// Two billable lines and one already billed on an earlier invoice. The totals
// below deliberately EXCLUDE the locked line, exactly as the server computes
// them — which is what made printing it a contradiction rather than a detail.
const PDF_DATA = {
  company_name: 'Alphalize',
  company_logo_b64: '',
  bill_to_name: 'Nexgenn',
  client_name: 'Nexgenn',
  project_name: 'Restaurant App',
  has_rate: true,
  currency: { name: 'INR', symbol: '₹', position: 'before', decimal_places: 2 },
  invoice: {
    name: 'INV/2026/0042',
    state: 'finalized',
    payment_status: 'unpaid',
    client_paid_claim: false,
    invoice_date: '2026-09-10',
    from_date: '2026-08-01',
    to_date: '2026-08-31',
    invoice_title: 'August services',
    billing_method: 'hourly',
    hourly_rate: 100,
    grand_total_hours: 3,
    total_amount: 300,
    notes: '<p>Thanks for the work this month.</p>',
    lines: [
      { id: 1, description: 'Login screen', quoted_hours: 2, unit_price: 0, line_type: 'kpi', already_invoiced: false },
      { id: 2, description: 'Signup screen', quoted_hours: 1, unit_price: 0, line_type: 'kpi', already_invoiced: false },
      { id: 3, description: 'Billed last month', quoted_hours: 9, unit_price: 0, line_type: 'kpi', already_invoiced: true },
    ],
  },
};

// jsPDF keeps the drawn strings in its internal page context; that is the only
// way to assert on what a PDF actually SAYS without re-parsing the file.
function textOf(doc) {
  const pages = doc.internal.pages || [];
  return pages.flat().filter((s) => typeof s === 'string').join('\n');
}

describe('invoice PDF', () => {
  test('drops already-billed lines, so the rows sum to the stated total', () => {
    const body = textOf(buildInvoicePdf(PDF_DATA, true));
    expect(body).toContain('Login screen');
    expect(body).toContain('Signup screen');
    // The whole point: this line is not part of the 300 total, so it must not be
    // printed as though it were.
    expect(body).not.toContain('Billed last month');
  });

  test('"Show amounts" off produces a cost-free sheet', () => {
    const withMoney = textOf(buildInvoicePdf(PDF_DATA, true));
    const without = textOf(buildInvoicePdf(PDF_DATA, false));
    expect(withMoney).toContain('Total Amount');
    // Hours still there — it is a delivery sheet, not an empty one.
    expect(without).toContain('Total Hours');
    expect(without).not.toContain('Total Amount');
    expect(without).not.toContain('Currency');
  });

  test('prints Overall Notes, with the HTML stripped', () => {
    const body = textOf(buildInvoicePdf(PDF_DATA, true));
    expect(body).toContain('Notes:');
    expect(body).toContain('Thanks for the work this month.');
    expect(body).not.toContain('<p>');
  });

  test('filename carries the payment state, and no slashes', () => {
    expect(invoiceFileName(PDF_DATA)).toBe('INV_2026_0042_UNPAID.pdf');
    // A draft has no payment state to report yet.
    const draft = { ...PDF_DATA, invoice: { ...PDF_DATA.invoice, state: 'draft' } };
    expect(invoiceFileName(draft)).toBe('INV_2026_0042.pdf');
  });

  test('hands back base64 the save paths can write', () => {
    const out = makeInvoicePdf(PDF_DATA, true);
    expect(out.status).toBe(true);
    expect(out.mimeType).toBe('application/pdf');
    // No data: prefix — the callers write the payload straight to a file.
    expect(out.data_b64.startsWith('data:')).toBe(false);
    expect(Buffer.from(out.data_b64, 'base64').toString('latin1').startsWith('%PDF')).toBe(true);
  });
});
