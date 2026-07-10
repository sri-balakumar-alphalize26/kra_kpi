// Owner Dashboard service — "certified tasks ready to invoice" per client.
// Mirrors the Odoo kpi_owner_dashboard component: same routes, same fields.
// Falls back to mock data when no server is configured (offline review).

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('OwnerSvc');
const LONG = 30000;

async function server() {
  const { serverUrl } = await getConnection();
  return serverUrl || '';
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const MOCK_CLIENTS = [
  {
    client_id: 1, client_name: 'Demo Client', parent_name: 'Alphalize', currency_name: '',
    completed_count: 0, awaiting_client_count: 0, in_progress_count: 0,
    total_actual_hours: 0, total_quoted_hours: 0,
    last_invoice_name: '', last_invoice_state: '', last_invoice_date: '',
    projects: [
      { project_id: 11, project_name: 'Website', completed_count: 0, awaiting_client_count: 0, in_progress_count: 0, total_actual_hours: 0, total_quoted_hours: 0 },
    ],
  },
  {
    client_id: 2, client_name: 'Alphalize', parent_name: '', currency_name: '',
    completed_count: 0, awaiting_client_count: 0, in_progress_count: 2,
    total_actual_hours: 0, total_quoted_hours: 0,
    last_invoice_name: '', last_invoice_state: '', last_invoice_date: '',
    projects: [
      { project_id: 21, project_name: 'Demo Client', completed_count: 0, awaiting_client_count: 0, in_progress_count: 0, total_actual_hours: 0, total_quoted_hours: 0 },
    ],
  },
];

// Per-client certified summary → { status, clients:[...] }.
export async function getCertifiedByClient() {
  const base = await server();
  if (!base) { log.info('getCertifiedByClient: no server → mock'); await delay(300); return { isMock: true, clients: MOCK_CLIENTS }; }
  log.info('getCertifiedByClient → /kpi_owner/certified_by_client');
  const res = await jsonRpc(base, '/kpi_owner/certified_by_client', {}, LONG);
  if (!res || res.status === false) throw new Error(res?.message || 'Could not load dashboard');
  log.info('getCertifiedByClient ←', { clients: (res.clients || []).length });
  return { isMock: false, clients: res.clients || [] };
}

// Certified tasks for one client → { status, client_name, tasks:[...] }.
export async function getClientCertifiedTasks(clientKraId) {
  const base = await server();
  if (!base) {
    await delay(250);
    return { isMock: true, tasks: [], client_name: '' };
  }
  log.info('getClientCertifiedTasks → /kpi_owner/client_certified_tasks', { client_kra_id: clientKraId });
  const res = await jsonRpc(base, '/kpi_owner/client_certified_tasks', { client_kra_id: Number(clientKraId) }, LONG);
  if (!res || res.status === false) throw new Error(res?.message || 'Could not load certified tasks');
  return { isMock: false, tasks: res.tasks || [], client_name: res.client_name || '' };
}

// Create a draft invoice for a client (optionally scoped to sub-KRAs/projects).
// Covers a wide date range so all eligible time logs are pulled in, matching the
// dashboard's "invoice everything certified" intent.
export async function createInvoice({ clientKraId, subKraIds = [], fromDate, toDate }) {
  const base = await server();
  const params = {
    client_kra_id: Number(clientKraId),
    from_date: fromDate || '2000-01-01',
    to_date: toDate || '2099-12-31',
    filter_sub_kra_ids: (subKraIds || []).map(Number),
  };
  if (!base) { log.info('createInvoice (mock)', params); await delay(400); return { isMock: true, invoice_id: Math.floor(Math.random() * 1e6) }; }
  log.info('createInvoice → /kpi_client_invoice/create', params);
  const res = await jsonRpc(base, '/kpi_client_invoice/create', params, LONG);
  if (!res || res.status === false) throw new Error(res?.message || 'Could not create invoice');
  log.info('createInvoice ←', { invoice_id: res.invoice_id });
  return { isMock: false, invoice_id: res.invoice_id, data: res.data };
}
