/* The browser's side of the proxy. Every screen reads the backend through
   this, so the awkward parts of the contract are handled once, here.

   rpc(path, params)      one JSON-RPC call (writes, one-off reads)
   read(path, params)     the same, cached 15 s and shared between callers
   mutate(path, params, fn) edit a cached read in place, without a request
   upload(path, formData) multipart with progress (the file-upload routes)
   href(path)             the URL of a type='http' download, for <a href>
   serverNow()            Date.now() corrected onto Odoo's clock */

export class ApiError extends Error {
  constructor(message, { status = 0, field = null, data = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.field = field;   /* {ok:false, error, field} -> inline under that control */
    this.data = data;
  }
}

const BASE = "/api/kpi";
export const OFFLINE = "Can't reach the server. Try again in a moment.";
export const href = (path) => BASE + path;

/* ---- server clock -------------------------------------------------------
   Every live timer is "now minus a timestamp the SERVER wrote". A PC clock a
   minute off makes a break that just started read a minute old, so the proxy
   forwards Odoo's Date header and each answer re-measures the offset. */
let skewMs = 0;
function learnSkew(res) {
  const d = Date.parse(res.headers.get("x-odoo-date") || "");
  if (!Number.isNaN(d)) skewMs = Date.now() - d;
}
export const serverNow = () => Date.now() - skewMs;
export const clockSkewMs = () => skewMs;

/* ---- signed out ---------------------------------------------------------
   One event per expiry, not one per failing poll; the Gate redirects. */
let firing = false;
function fireSignedOut() {
  if (firing || typeof window === "undefined") return;
  firing = true;
  window.dispatchEvent(new CustomEvent("kpi:signedout"));
  setTimeout(() => { firing = false; }, 10000);
}

/* A request that never settles is worse than one that fails. Odoo's own
   limit_time_real is 120 s; AI suggestions and PDF builds can take a while. */
const TIMEOUT_MS = 60000;

async function send(url, { body, timeout = TIMEOUT_MS } = {}) {
  let res, data;
  try {
    res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeout) : undefined,
    });
  } catch (e) {
    throw new ApiError(OFFLINE, { status: 0 });
  }
  learnSkew(res);
  try { data = await res.json(); } catch (e) { data = null; }
  if (res.status === 401) fireSignedOut();
  if (!res.ok) {
    throw new ApiError(data?.error || OFFLINE, { status: res.status, field: data?.field ?? null, data });
  }
  return data;
}

/* Writes and one-off reads. The answer is Odoo's unwrapped `result`. Many
   routes report a logical failure as {status:false, error|message} on HTTP
   200 — that is left to the caller (services throw on it), exactly as the
   mobile app does. */
export function rpc(path, params = {}, { timeout } = {}) {
  return send(BASE + path, { body: params, timeout });
}

/* ---- cached reads --------------------------------------------------------
   Keyed by path + params. Short TTL: boards move. `peek` hands a screen what
   it last knew synchronously so it can draw at once while refreshing. */
const cache = new Map();   /* key -> { at, promise } */
const settled = new Map(); /* key -> { at, value } */
const TTL = 15 * 1000;
const PEEK_MAX_AGE = 10 * 60 * 1000;

export function stableKey(path, params) {
  const sort = (v) => (v && typeof v === "object" && !Array.isArray(v))
    ? Object.keys(v).sort().reduce((o, k) => { o[k] = sort(v[k]); return o; }, {})
    : Array.isArray(v) ? v.map(sort) : v;
  return path + "|" + JSON.stringify(sort(params ?? {}));
}

export function invalidate(prefix = "") {
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
  for (const k of [...settled.keys()]) if (k.startsWith(prefix)) settled.delete(k);
}

export function peek(path, params) {
  const hit = settled.get(stableKey(path, params));
  return hit && Date.now() - hit.at < PEEK_MAX_AGE ? hit.value : undefined;
}

/* A request already on the wire is shared even with `fresh`: two screens (or
   a poll and an action's refresh) asking at once get ONE answer, not two
   racing full loads. invalidate() drops it, so a read after a write still
   goes to the server. */
export function read(path, params = {}, { fresh = false, ttl = TTL, timeout } = {}) {
  const key = stableKey(path, params);
  const hit = cache.get(key);
  if (hit && (hit.pending || (!fresh && Date.now() - hit.at < ttl))) return hit.promise;
  const entry = { at: Date.now(), promise: null, pending: true };
  entry.promise = send(BASE + path, { body: params, timeout }).then((value) => {
    entry.pending = false;
    /* Dropped by invalidate() or replaced by mutate() meanwhile: this answer
       predates that, so it must not become what peek() hands out. */
    if (cache.get(key) === entry && value && value.status !== false) settled.set(key, { at: Date.now(), value });
    return value;
  }, (e) => {
    entry.pending = false;
    if (cache.get(key) === entry) cache.delete(key); /* never cache a failure */
    throw e;
  });
  cache.set(key, entry);
  return entry.promise;
}

/* ---- local edits ---------------------------------------------------------
   mutate(path, params, fn): change what the app holds for one read without
   asking the server, e.g. slot a just-created task into the cached board
   instead of re-downloading every task. `fn(value)` returns the new value
   (undefined = leave it). Screens showing that read (lib/useFetch) hear about
   it through watch() and apply the same `fn` to what they hold. */
const watchers = new Map(); /* key -> Set(fn) */
export function watch(path, params, fn) {
  const key = stableKey(path, params);
  if (!watchers.has(key)) watchers.set(key, new Set());
  watchers.get(key).add(fn);
  return () => { watchers.get(key)?.delete(fn); };
}
export function mutate(path, params, fn) {
  const key = stableKey(path, params);
  const hit = settled.get(key);
  const next = hit ? fn(hit.value) : undefined;
  if (next !== undefined) {
    const at = Date.now();
    settled.set(key, { at, value: next });
    cache.set(key, { at, promise: Promise.resolve(next), pending: false });
  } else {
    cache.delete(key); /* nothing held to edit: the next read asks the server */
  }
  for (const w of [...(watchers.get(key) || [])]) w(fn);
  return next;
}

/* ---- uploads -------------------------------------------------------------
   XHR, because fetch has no upload progress. The upload routes answer plain
   JSON (not the envelope); it is returned as-is. */
export function upload(path, formData, { timeout = 120000, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", BASE + path);
    xhr.timeout = timeout;
    xhr.withCredentials = true;
    if (onProgress) xhr.upload.onprogress = (e) => { try { onProgress(e.loaded || 0, e.total || 0); } catch (_) {} };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (_) {}
      if (xhr.status === 401) fireSignedOut();
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(data?.error || data?.message || OFFLINE, { status: xhr.status, data }));
    };
    xhr.onerror = () => reject(new ApiError(OFFLINE, { status: 0 }));
    xhr.ontimeout = () => reject(new ApiError("The upload took too long.", { status: 0 }));
    xhr.send(formData);
  });
}

/* Odoo ORM call for the few models that have no custom route (kpi.reminder,
   app.user.manual) — the mobile uses call_kw for these too. */
export function callKw(model, method, args = [], kwargs = {}) {
  return rpc("/web/dataset/call_kw", { model, method, args, kwargs });
}

/* The services report failure as {status:false, error|message}. */
export function assertOk(res, fallback = "Request failed.") {
  if (!res || res.status === false) throw new ApiError(res?.error || res?.message || fallback, { status: 400, data: res });
  return res;
}
