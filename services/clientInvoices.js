// Client Invoices (admin) — wraps /kpi_client_invoice/* in kpi_reports_api.py.
// All routes are type='json'. The PDF is rendered server-side (reportlab) and
// returned as base64. Mock-safe with no server.

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('ClientInvoices');

async function call(path, params = {}, timeout) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: false, message: 'No server connection' };
  try {
    return (await jsonRpc(serverUrl, path, params, timeout)) || { status: false };
  } catch (e) {
    log.warn('call failed', path, e?.message);
    return { status: false, message: e?.message || 'Request failed' };
  }
}

export const fetchInvoiceList = (status_filter = 'all', client_kra_id = false) =>
  call('/kpi_client_invoice/list', { status_filter, client_kra_id });
export const fetchInvoice = (invoice_id) => call('/kpi_client_invoice/get', { invoice_id });
export const fetchInvoiceFilters = () => call('/kpi_client_invoice/get_filters', {});
export const fetchInvoiceCurrencies = () => call('/kpi_client_invoice/get_currencies', {});
export const fetchSubKras = (client_kra_id) => call('/kpi_client_invoice/get_sub_kras_for_client', { client_kra_id });
export const fetchClientUsersKpis = (client_kra_id, sub_kra_ids) =>
  call('/kpi_client_invoice/get_client_users_and_kpis', { client_kra_id, sub_kra_ids });
export const createInvoice = (params) => call('/kpi_client_invoice/create', params, 60000);
export const saveInvoiceHeader = (params) => call('/kpi_client_invoice/save_header', params);
export const saveInvoiceLine = (params) => call('/kpi_client_invoice/save_line', params);
export const addAdjustment = (params) => call('/kpi_client_invoice/add_adjustment', params);
export const removeInvoiceLine = (line_id) => call('/kpi_client_invoice/remove_line', { line_id });
export const saveInvoiceNotes = (invoice_id, notes) => call('/kpi_client_invoice/save_notes', { invoice_id, notes });
export const finalizeInvoice = (invoice_id) => call('/kpi_client_invoice/finalize', { invoice_id });
export const sendInvoice = (invoice_id) => call('/kpi_client_invoice/send', { invoice_id });
export const resetInvoiceDraft = (invoice_id) => call('/kpi_client_invoice/reset_draft', { invoice_id });
// Draft only — the server refuses anything finalized, sent or paid. Deleting a draft
// frees any tasks it was holding back from future invoices.
export const deleteInvoice = (invoice_id) => call('/kpi_client_invoice/delete', { invoice_id });
// How money moved. Must match PAYMENT_METHODS in models/kpi_client_invoice.py, which
// is what validates it — an unknown value is rejected outright.
export const PAYMENT_METHODS = [
  { code: 'bank_transfer', label: 'Bank Transfer' },
  { code: 'cash', label: 'Cash' },
  { code: 'cheque', label: 'Cheque' },
  { code: 'card', label: 'Card' },
  { code: 'other', label: 'Other' },
];

// `method` is how the payment actually arrived. Omitting it no longer fails — the
// server records 'other' so older builds keep working — but always send it: an
// invoice that is paid without saying how leaves nothing to reconcile later.
export const markInvoicePaid = (invoice_id, paid, note, method) =>
  call('/kpi_client_invoice/mark_paid', { invoice_id, paid, note, method: method || '' });
// Client-only: flag "I've paid" → notifies admins to confirm (no state change).
export const clientMarkPaid = (invoice_id, method, note) =>
  call('/kpi_client_invoice/client_mark_paid', { invoice_id, method: method || '', note: note || '' });
export const fetchInvoicePdf = (invoice_id) => call('/kpi_client_invoice/pdf', { invoice_id }, 60000);
