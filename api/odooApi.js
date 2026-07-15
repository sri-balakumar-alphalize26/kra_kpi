// Standard Odoo JSON-RPC client for the KRA/KPI login flow.
// The kra_kpi_module backend exposes no custom login route, so we use Odoo's
// built-in endpoints: /web/database/list (database list) and
// /web/session/authenticate (username/password auth).
// Bare axios on purpose — no shared interceptors to fire during pre-login calls.

import axios from 'axios';
import { createLogger } from './logger';

const log = createLogger('OdooAPI');

const JSONRPC_HEADERS = { 'Content-Type': 'application/json' };
const TIMEOUT_MS = 10000;

// Trim, add http:// if no scheme was typed, and strip trailing slashes.
export function normalizeUrl(baseUrl = '') {
  let url = baseUrl.trim();
  if (url && !url.startsWith('http')) url = 'http://' + url;
  return url.replace(/\/+$/, '');
}

function jsonrpcBody(params) {
  return { jsonrpc: '2.0', method: 'call', params };
}

// Fetch the list of databases on an Odoo server.
// Tries POST /web/database/list (JSON-RPC), falls back to GET /web/database/list.
// Returns a string[] of database names.
export async function fetchDatabases(baseUrl) {
  const base = normalizeUrl(baseUrl);
  const opts = { headers: JSONRPC_HEADERS, timeout: TIMEOUT_MS };
  let lastError = null;

  log.info('fetchDatabases → POST', `${base}/web/database/list`);
  try {
    const res = await axios.post(`${base}/web/database/list`, jsonrpcBody({}), opts);
    if (res.data?.error) {
      throw new Error(res.data.error.data?.message || 'Database listing is disabled');
    }
    const result = res.data?.result;
    if (Array.isArray(result) && result.length > 0) {
      log.info('fetchDatabases ← POST ok', { count: result.length, databases: result });
      return result;
    }
    if (Array.isArray(result?.databases) && result.databases.length > 0) {
      log.info('fetchDatabases ← POST ok', { count: result.databases.length, databases: result.databases });
      return result.databases;
    }
    log.warn('fetchDatabases: POST returned no databases, trying GET');
  } catch (err) {
    lastError = err;
    log.warn('fetchDatabases: POST failed, trying GET', err?.message);
  }

  log.info('fetchDatabases → GET', `${base}/web/database/list`);
  try {
    const res = await axios.get(`${base}/web/database/list`, { timeout: TIMEOUT_MS });
    if (Array.isArray(res.data)) {
      log.info('fetchDatabases ← GET ok', { count: res.data.length });
      return res.data;
    }
    if (Array.isArray(res.data?.result)) {
      log.info('fetchDatabases ← GET ok', { count: res.data.result.length });
      return res.data.result;
    }
  } catch (err) {
    lastError = err;
    log.warn('fetchDatabases: GET failed', err?.message);
  }

  if (lastError) {
    log.error('fetchDatabases: all attempts failed', lastError?.message);
    throw lastError;
  }
  log.warn('fetchDatabases: no databases found (empty)');
  return [];
}

// Authenticate a user against a database via /web/session/authenticate.
// Resolves to the Odoo session result ({ uid, name, username, ... }).
// Older Odoo returns { uid: false } for bad credentials; modern Odoo (v14+)
// returns a JSON-RPC error (AccessDenied) instead. We normalize the latter to
// a thrown error tagged `isAuthError` so the caller can point the message at
// the credential fields rather than the server-URL field.
export async function authenticate(baseUrl, db, login, password) {
  const base = normalizeUrl(baseUrl);
  log.info('authenticate →', `${base}/web/session/authenticate`, { db, login });
  let res;
  try {
    res = await axios.post(
      `${base}/web/session/authenticate`,
      jsonrpcBody({ db, login, password }),
      { headers: JSONRPC_HEADERS, timeout: TIMEOUT_MS }
    );
  } catch (err) {
    // Network/HTTP-level failure (server unreachable, timeout, 500…).
    log.error('authenticate ✗ network/http error', err?.message);
    throw err;
  }
  if (res.data?.error) {
    const odooErr = res.data.error;
    const name = odooErr.data?.name || '';
    const message = odooErr.data?.message || odooErr.message || 'Authentication failed';
    const err = new Error(message);
    // AccessDenied / AccessError => wrong username or password.
    err.isAuthError = /AccessDenied|AccessError/i.test(name) || /access denied|wrong login|wrong password/i.test(message);
    log.warn('authenticate ✗ odoo error', { name, message, isAuthError: err.isAuthError });
    throw err;
  }
  const result = res.data?.result || { uid: false };
  log.info('authenticate ←', { uid: result.uid, name: result.name, username: result.username });
  return result;
}

// Call an Odoo model method via /web/dataset/call_kw. Relies on the session
// cookie set by authenticate() (axios sends it automatically once logged in).
// Returns the method's raw result. Throws on an Odoo-level error.
export async function callKw(baseUrl, model, method, args = [], kwargs = {}) {
  const base = normalizeUrl(baseUrl);
  log.info('callKw →', `${model}.${method}`, { args, kwargs });
  let res;
  try {
    res = await axios.post(
      `${base}/web/dataset/call_kw`,
      jsonrpcBody({ model, method, args, kwargs }),
      { headers: JSONRPC_HEADERS, timeout: TIMEOUT_MS, withCredentials: true }
    );
  } catch (err) {
    log.error('callKw ✗ network/http error', `${model}.${method}`, err?.message);
    throw err;
  }
  if (res.data?.error) {
    const message = res.data.error.data?.message || 'Odoo request failed';
    log.warn('callKw ✗ odoo error', `${model}.${method}`, message);
    throw new Error(message);
  }
  log.info('callKw ←', `${model}.${method} ok`);
  return res.data?.result;
}

// Call a module JSON controller route (type='json' @http.route, e.g.
// /kra_kpi/tasks/get). These take params as the JSON-RPC `params` object and
// return { result: ... }. Relies on the session cookie from authenticate().
// `timeout` overrides the default 10s window (e.g. AI suggestions / bulk writes
// that legitimately take longer).
// `onProgress(sentBytes, totalBytes)` — optional. Fires while the request body
// is uploaded, so a file upload can show a live percentage.
//
// The module notes elsewhere that "base64-in-JSON can't" report progress — that
// is true of the WEB's OWL rpc() helper, but axios uses XHR under React Native
// and RN implements xhr.upload.onprogress, so it works here on the plain JSON
// route with no multipart needed. NOTE: `total` is the BASE64 body (~+33% of the
// file), so drive any bar off these numbers rather than the raw file size.
export async function jsonRpc(baseUrl, path, params = {}, timeout = TIMEOUT_MS, db = null, onProgress = null) {
  const base = normalizeUrl(baseUrl);
  log.info('jsonRpc →', path, log.redact(params));
  // Pre-login (public) routes have no session cookie yet, so on a multi-db
  // server the DB must be named explicitly via the X-Odoo-Database header.
  const headers = db ? { ...JSONRPC_HEADERS, 'X-Odoo-Database': db } : JSONRPC_HEADERS;
  let res;
  try {
    const cfg = { headers, timeout, withCredentials: true };
    if (onProgress) {
      cfg.onUploadProgress = (e) => {
        try { onProgress(e.loaded || 0, e.total || 0); } catch (_) {}
      };
    }
    res = await axios.post(
      `${base}${path}`,
      jsonrpcBody(params),
      cfg
    );
  } catch (err) {
    log.error('jsonRpc ✗ network/http error', path, err?.message);
    throw err;
  }
  if (res.data?.error) {
    const message = res.data.error.data?.message || 'Request failed';
    log.warn('jsonRpc ✗ odoo error', path, message);
    throw new Error(message);
  }
  log.info('jsonRpc ←', path, 'ok');
  return res.data?.result;
}

// POST multipart/form-data to an @http.route(type='http') endpoint — the way the
// web uploads a progress file (/kpi/progress/upload_file). Two reasons to prefer
// this over base64-in-JSON for files: the file streams straight from disk (no
// ~+33% base64 inflation and no whole-file string in memory), and that route
// accepts 50 MB where the JSON one is only meant for small payloads.
//
// These routes reply with request.make_json_response(...) — a PLAIN JSON body,
// NOT the JSON-RPC {result:...} envelope — so the body is returned as-is.
// Auth is the session cookie, same as jsonRpc.
export async function httpUpload(baseUrl, path, formData, timeout = 120000, onProgress = null) {
  const base = normalizeUrl(baseUrl);
  log.info('httpUpload →', path);
  const cfg = {
    timeout,
    withCredentials: true,
    // Let the runtime set Content-Type so it can add the multipart boundary.
    headers: { 'Content-Type': 'multipart/form-data' },
  };
  if (onProgress) {
    cfg.onUploadProgress = (e) => {
      try { onProgress(e.loaded || 0, e.total || 0); } catch (_) {}
    };
  }
  let res;
  try {
    res = await axios.post(`${base}${path}`, formData, cfg);
  } catch (err) {
    log.error('httpUpload ✗ network/http error', path, err?.message);
    throw err;
  }
  log.info('httpUpload ←', path, { status: res.data?.status });
  return res.data;
}

// Map a network/HTTP error to a short, user-friendly message.
export function friendlyError(err, fallback = 'Something went wrong') {
  const msg = err?.message || '';
  const code = err?.code || '';
  if (msg.includes('timeout') || code === 'ECONNABORTED') {
    return 'Connection timed out — is the server running?';
  }
  if (
    msg.includes('Network Error') ||
    msg.includes('Network request failed') ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ERR_NETWORK'
  ) {
    return 'Cannot reach server — check the URL, IP address and port';
  }
  if (msg.includes('404')) {
    return 'Server found, but database listing is disabled';
  }
  return msg || fallback;
}
