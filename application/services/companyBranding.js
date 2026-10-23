// Company Branding — set the company name + logo shown on generated PDFs
// (daily task report, work report, client invoices). Wraps /kra_kpi/company/*
// in controllers/kra_api.py. Admin-gated server-side. Mock-safe with no server.

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('CompanyBranding');

export async function fetchCompanyBranding() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, name: '', logo_b64: '', isMock: true };
  const res = await jsonRpc(serverUrl, '/kra_kpi/company/get', {});
  log.info('branding ←', { status: res?.status, hasLogo: !!res?.logo_b64 });
  return res || { status: false };
}

// name is required; an empty logo_b64 clears the logo. 60s timeout for the upload.
export async function saveCompanyBranding({ name, logo_b64 }) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, name };
  return jsonRpc(serverUrl, '/kra_kpi/company/save', { name, logo_b64 }, 60000);
}
