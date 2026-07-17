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
export const markInvoicePaid = (invoice_id, paid, note) =>
  call('/kpi_client_invoice/mark_paid', { invoice_id, paid, note });
// Client-only: flag "I've paid" → notifies admins to confirm (no state change).
export const clientMarkPaid = (invoice_id) =>
  call('/kpi_client_invoice/client_mark_paid', { invoice_id });
export const fetchInvoicePdf = (invoice_id) => call('/kpi_client_invoice/pdf', { invoice_id }, 60000);
