// KRA/KPI data service. getKraTree() returns the SAME shape as the Odoo method
// kra.master.get_kra_tree(), so the dashboard screen never changes:
//   { id, name, parent, child_ids: [ ...node ], kpi_ids: [ { id, name, has_user_manual, manual_count } ] }
//
// Behaviour:
//   • If a server connection is saved (user logged in via ConnectScreen), it calls
//     the live Odoo backend through api/odooApi.callKw and returns the real tree.
//   • Otherwise (no server, or the call fails) it falls back to MOCK_TREE so the
//     screen is still reviewable in Expo without a backend.

import { getConnection } from '../api/session';
import { callKw, jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('KraKpiSvc');

async function server() {
  const { serverUrl } = await getConnection();
  return serverUrl || '';
}

export const PRIORITIES = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'important', label: 'Important' },
  { value: 'regular', label: 'Regular' },
];

const MOCK_TREE = [
  {
    id: 1,
    name: 'Nexgenn',
    parent: null,
    kpi_ids: [],
    child_ids: [
      {
        id: 11,
        name: 'Restaurant',
        parent: 1,
        kpi_ids: [],
        child_ids: [
          {
            id: 111,
            name: 'Mobile App',
            parent: 11,
            child_ids: [],
            kpi_ids: [
              { id: 1001, name: 'REQ-001 Login & OTP', has_user_manual: true, manual_count: 2 },
              { id: 1002, name: 'REQ-002 Menu & Cart', has_user_manual: false, manual_count: 0 },
              { id: 1003, name: 'BUG-014 Payment retry', has_user_manual: true, manual_count: 1 },
            ],
          },
          {
            id: 112,
            name: 'Admin Panel',
            parent: 11,
            child_ids: [],
            kpi_ids: [
              { id: 1004, name: 'REQ-020 Order dashboard', has_user_manual: false, manual_count: 0 },
              { id: 1005, name: 'UPT-007 Export invoices', has_user_manual: true, manual_count: 3 },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 2,
    name: 'Goldenspoon',
    parent: null,
    kpi_ids: [],
    child_ids: [
      {
        id: 21,
        name: 'Vegetable POS - APK',
        parent: 2,
        child_ids: [],
        kpi_ids: [
          { id: 2001, name: 'REQ-101 Barcode scan', has_user_manual: true, manual_count: 1 },
          { id: 2002, name: 'REQ-102 Daily sales report', has_user_manual: false, manual_count: 0 },
          { id: 2003, name: 'UPT-045 Printer support', has_user_manual: false, manual_count: 0 },
          { id: 2004, name: 'BUG-060 Sync on reconnect', has_user_manual: true, manual_count: 1 },
        ],
      },
    ],
  },
];

// Fetch the KRA → sub-KRA → KPI hierarchy.
// isMock is surfaced so the screen can show a "sample data" hint when offline.
export async function getKraTree() {
  const { serverUrl } = await getConnection();
  if (serverUrl) {
    log.info('getKraTree → kra.master.get_kra_tree');
    const result = await callKw(serverUrl, 'kra.master', 'get_kra_tree');
    log.info('getKraTree ←', { roots: (result || []).length });
    return { tree: result || [], isMock: false };
  }
  // No server configured yet — show sample data so the UI is reviewable.
  await new Promise((r) => setTimeout(r, 400));
  return { tree: MOCK_TREE, isMock: true };
}

// ---- Dropdown data --------------------------------------------------------

// All KRAs (for the "Parent KRA" selector) → [{id, name}].
export async function getParentKras() {
  const base = await server();
  if (!base) return { isMock: true, kras: flattenMock(MOCK_TREE) };
  log.info('getParentKras → kra.master.get_parent_kras');
  const res = await callKw(base, 'kra.master', 'get_parent_kras', []);
  return { isMock: false, kras: res || [] };
}

// Internal users (for the KPI "Assignee" selector) → [{id, name}].
export async function getUsers() {
  const base = await server();
  if (!base) return { isMock: true, users: [{ id: 2, name: 'Admin' }, { id: 7, name: 'Priya Dev' }] };
  log.info('getUsers → res.users.search_read');
  const res = await callKw(base, 'res.users', 'search_read', [[], ['id', 'name']]);
  return { isMock: false, users: res || [] };
}

// ---- Create ---------------------------------------------------------------

// Create a KRA (root when parentId falsy, else a sub-KRA). Returns new id.
export async function createKra({ name, parentId }) {
  const base = await server();
  const parent_id = parentId ? Number(parentId) : false;
  const payload = { name: (name || '').trim(), is_sub: !!parent_id, parent_id, client_user_ids: [] };
  if (!base) { log.info('createKra (mock)', payload); await delay(300); return { isMock: true, id: Math.floor(Math.random() * 1e6) }; }
  log.info('createKra → kra.master.create_kra', payload);
  const id = await callKw(base, 'kra.master', 'create_kra', [payload]);
  log.info('createKra ←', { id });
  return { isMock: false, id };
}

// Create a KPI under a KRA. Returns new id.
export async function createKpi({ name, kraId, estimateHours, estimateMinutes, priority, userId, description, deadline }) {
  const base = await server();
  const payload = {
    name: (name || '').trim(),
    kra_id: Number(kraId),
    estimate_hours: Number(estimateHours) || 0,
    estimate_minutes: Number(estimateMinutes) || 0,
    priority: priority || 'regular',
    user_id: userId ? Number(userId) : false,
    description: description || '',
    deadline: deadline || false,
  };
  if (!base) { log.info('createKpi (mock)', payload); await delay(300); return { isMock: true, id: Math.floor(Math.random() * 1e6) }; }
  log.info('createKpi → kra.kpi.create_kpi', payload);
  const id = await callKw(base, 'kra.kpi', 'create_kpi', [payload]);
  log.info('createKpi ←', { id });
  return { isMock: false, id };
}

// ---- Edit / Delete --------------------------------------------------------

// Rename a KRA via the dedicated route (does a duplicate-name check server-side).
export async function updateKra({ kraId, name }) {
  const base = await server();
  if (!base) { log.info('updateKra (mock)', { kraId, name }); await delay(200); return { isMock: true }; }
  log.info('updateKra → /kra_kpi/update_kra', { kra_id: kraId, name });
  const res = await jsonRpc(base, '/kra_kpi/update_kra', { kra_id: Number(kraId), name: (name || '').trim() });
  if (!res || res.status === false) throw new Error(res?.message || 'Could not rename KRA');
  return { isMock: false, new_name: res.new_name };
}

// Rename a KPI (no dedicated route; standard write, no override exists).
export async function updateKpi({ kpiId, name }) {
  const base = await server();
  if (!base) { log.info('updateKpi (mock)', { kpiId, name }); await delay(200); return { isMock: true }; }
  log.info('updateKpi → kra.kpi.write', { kpiId, name });
  await callKw(base, 'kra.kpi', 'write', [[Number(kpiId)], { name: (name || '').trim() }]);
  return { isMock: false };
}

// Delete a KRA (cascades its KPIs + child KRAs, server-side).
export async function deleteKra(kraId) {
  const base = await server();
  if (!base) { log.info('deleteKra (mock)', { kraId }); await delay(200); return { isMock: true }; }
  log.info('deleteKra → /kra_kpi/delete_kra', { kra_id: kraId });
  const res = await jsonRpc(base, '/kra_kpi/delete_kra', { kra_id: Number(kraId) });
  if (!res || res.status === false) throw new Error(res?.message || 'Could not delete KRA');
  return { isMock: false };
}

// Delete a single KPI.
export async function deleteKpi(kpiId) {
  const base = await server();
  if (!base) { log.info('deleteKpi (mock)', { kpiId }); await delay(200); return { isMock: true }; }
  log.info('deleteKpi → /kra_kpi/delete_kpi', { kpi_id: kpiId });
  const res = await jsonRpc(base, '/kra_kpi/delete_kpi', { kpi_id: Number(kpiId) });
  if (!res || res.status === false) throw new Error(res?.message || 'Could not delete KPI');
  return { isMock: false };
}

// ---- helpers --------------------------------------------------------------

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Flatten the mock tree to a [{id,name}] list for the offline parent selector.
function flattenMock(nodes, out = []) {
  for (const n of nodes) { out.push({ id: n.id, name: n.name }); flattenMock(n.child_ids || [], out); }
  return out;
}
