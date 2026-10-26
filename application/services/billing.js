// Billing settings data service — mirrors the web Settings › Billing page
// (web/components/settings/Billing.jsx) and Odoo's kpi_billing_settings screen.
// Wraps the /kpi_billing/* routes in controllers/kpi_billing_api.py.
//
// Every route answers {status:false, message:'Only an admin can change
// billing.'} for anyone below admin rather than raising, so callers must read
// `status` — a resolved promise is NOT a save.
//
// The price list is what a bill is made from when a task is 🏁 Full Complete:
// the client's own price for that work type, else the Default's. Falls back to
// mock data with no server.

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('Billing');
// The WhatsApp group list is read through the gateway and can be slow; the web
// gives it 45 s too.
const LONG = 45000;

const MOCK = {
  status: true,
  isMock: true,
  rates: [
    {
      id: 1, client_id: false, client_name: '', work_type: 'requirement', work_type_label: 'Requirement',
      method: 'per_task', amount: 5000, currency_id: 20, currency: 'INR', currency_symbol: '₹',
      date_from: '', date_to: '', always: true, range_label: 'Always', price_label: '₹ 5,000.00 per task', note: '',
    },
  ],
  clients: [
    {
      id: 7, name: 'Demo Client', currency: 'INR', invoice_group_jid: '', invoice_group_name: '',
      send_invoice: false, bill_address: '', bill_phone: '', bill_email: '', bill_tax_id: '', bill_logo: '',
    },
  ],
  currencies: [
    { id: 20, name: 'INR', symbol: '₹', active: true },
    { id: 1, name: 'USD', symbol: '$', active: true },
    { id: 120, name: 'OMR', symbol: 'ر.ع.', active: false },
  ],
  work_types: [
    { key: 'database', label: 'New Database' },
    { key: 'requirement', label: 'Requirement' },
    { key: 'bug', label: 'Bug' },
    { key: 'update', label: 'Update' },
  ],
  company_currency_id: 20,
  numbers: '',
};

// Everything the screen needs in one call:
// { status, rates:[{id, client_id, client_name, work_type, work_type_label,
//   method:'per_task'|'hourly', amount, currency_id, currency, currency_symbol,
//   date_from, date_to, always, range_label, price_label, note}],
//   clients:[{id, name, currency, invoice_group_jid, invoice_group_name,
//   send_invoice, bill_address, bill_phone, bill_email, bill_tax_id,
//   bill_logo (data URL or '')}],
//   currencies:[{id, name, symbol, active}], work_types:[{key, label}],
//   company_currency_id, numbers, ceo_numbers, review_days, skip_admin }
// date_from is '' when the price applies from the start (the server stores
// 2000-01-01 for "always").
export async function fetchBilling() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) { log.info('fetchBilling — no server, mock'); return MOCK; }
  log.info('fetchBilling → /kpi_billing/config');
  const res = await jsonRpc(serverUrl, '/kpi_billing/config', {}, LONG);
  return { isMock: false, ...(res || { status: false, message: 'No response.' }) };
}

// Add (no id) or edit one price. Empty client = the Default (every client).
// No date_from = always. Answers { status, rate } or { status:false, message }
// — the server refuses an overlapping price for the same client + work type.
export async function saveRate(r) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, rate: { ...r, id: r.id || Date.now() } };
  const payload = {
    id: r.id || null,
    client_id: r.client_id ? Number(r.client_id) : null,
    work_type: r.work_type,
    method: r.method,
    amount: r.amount,
    currency_id: r.currency_id ? Number(r.currency_id) : null,
    date_from: r.date_from || null,
    date_to: r.date_to || null,
    note: r.note || '',
  };
  log.info('saveRate → /kpi_billing/rate/save', { id: payload.id, client_id: payload.client_id, work_type: payload.work_type });
  return jsonRpc(serverUrl, '/kpi_billing/rate/save', payload);
}

// Delete one price. A price already used on a bill is archived instead (that
// bill still names the price that made it) — `archived` says which happened.
export async function deleteRate(id) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, archived: false };
  log.info('deleteRate → /kpi_billing/rate/delete', { id });
  return jsonRpc(serverUrl, '/kpi_billing/rate/delete', { id });
}

// The company's billing WhatsApp number(s), comma-separated ('' = off).
// Each is cleaned server-side (dial code added); answers { status, numbers }.
export async function setBillingNumbers(numbers) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, numbers: numbers || '' };
  return jsonRpc(serverUrl, '/kpi_billing/set_numbers', { numbers: numbers || '' });
}

// Per client: only the keys given are changed —
//   { jid, name }  the WhatsApp group its invoices go to (jid '' clears it;
//                  must end in @g.us)
//   { send }       the Send invoices switch
//   { details: { address, phone, email, tax_id, logo } }  printed under Bill
//                  To; logo is base64 ('' removes it)
// Answers the client's stored invoice fields (same keys as fetchBilling's
// clients), which win over what was sent.
export async function setClientInvoice(clientId, vals) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    return {
      status: true,
      invoice_group_jid: vals?.jid ?? '', invoice_group_name: vals?.name ?? '',
      send_invoice: !!vals?.send,
      bill_address: vals?.details?.address || '', bill_phone: vals?.details?.phone || '',
      bill_email: vals?.details?.email || '', bill_tax_id: vals?.details?.tax_id || '',
      bill_logo: vals?.details?.logo ? `data:image/png;base64,${vals.details.logo}` : '',
    };
  }
  log.info('setClientInvoice → /kpi_billing/client_invoice_set', { client_id: clientId, keys: Object.keys(vals || {}) });
  return jsonRpc(serverUrl, '/kpi_billing/client_invoice_set', { client_id: clientId, ...(vals || {}) });
}

// WhatsApp GROUPS only (jid ends in @g.us), for the invoice group picker —
// the same list the web reads (/kpi_wa_group/list). [{jid, name}]
export async function fetchInvoiceGroups() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return [{ jid: '120363000000000000@g.us', name: 'Demo client group' }];
  const res = await jsonRpc(serverUrl, '/kpi_wa_group/list', {}, LONG);
  if (!res || res.status === false) throw new Error(res?.message || 'Could not load the WhatsApp groups');
  return (res.groups || [])
    .filter((g) => String(g.jid || '').endsWith('@g.us'))
    .map((g) => ({ jid: g.jid, name: g.name || g.client_name || '' }));
}

// 🧾 Bill now — ONE task, by id. Makes the bill for a fully complete task that
// has none (no price matched, or the client's invoices are off). It is a task
// action on the web (TaskExtras.jsx), not part of the Billing page, and it can
// post the bill to the client's invoice group — confirm before calling.
// Answers { status, message, bill:{name, money, ...} } or { status:false, message }.
export async function billNow(kpiId) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, message: 'Bill made.', bill: { name: 'INV/DEMO/0001', money: '₹ 0.00' } };
  log.info('billNow → /kpi_billing/bill_now', { kpi_id: kpiId });
  const res = await jsonRpc(serverUrl, '/kpi_billing/bill_now', { kpi_id: kpiId });
  if (!res?.status) return { status: false, message: res?.message || 'Could not make the bill' };
  return res;
}
