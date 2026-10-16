"use client";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { read, peek, invalidate, stableKey, watch } from "./api";

/* A screen's read of one resource.

   useResource(path, params, { enabled, pollMs, keepLast, ttl, deps })
     → { data, error, loading, stale, refresh }

   Starts from what the app last knew (peek) so the screen draws at once,
   then refreshes. Polls pause while the tab is hidden. A failed refresh keeps
   the last data and reports `stale` instead of blanking the screen.

   Every screen asking for the same read (path + params) shares ONE store: one
   state, one poller (at the shortest pollMs asked for), one request at a time.
   The board, Your work, the list and the alerts used to poll the full task
   list each on their own clock. An unchanged answer keeps the same objects
   (share), so memoised cards and lanes skip a poll that changed nothing. */

const PEEK_MAX_AGE = 10 * 60 * 1000;
const stores = new Map(); /* key -> store */

/* The new answer, reusing every part of the old one that is equal: rows are
   matched by id, so an unchanged task keeps its object even if others moved. */
function share(a, b) {
  if (a === b) return a;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return b;
  if (Array.isArray(b)) {
    const byId = a.length && a[0] && typeof a[0] === "object" && a[0].id != null ? new Map(a.map((x) => [x?.id, x])) : null;
    let same = a.length === b.length;
    const out = b.map((x, i) => {
      const v = share(byId && x && typeof x === "object" && x.id != null ? byId.get(x.id) : a[i], x);
      if (v !== a[i]) same = false;
      return v;
    });
    return same ? a : out;
  }
  const keys = Object.keys(b);
  let same = keys.length === Object.keys(a).length;
  const out = {};
  for (const k of keys) {
    const v = share(a[k], b[k]);
    out[k] = v;
    if (v !== a[k] || !(k in a)) same = false;
  }
  return same ? a : out;
}

function storeFor(path, params, key) {
  let s = stores.get(key);
  /* Nobody has shown it for a while: start again from what peek() allows. */
  if (s && !s.listeners.size && !s.inflight && Date.now() - s.at > PEEK_MAX_AGE) {
    const data = peek(path, params);
    s.state = { data, error: null, loading: data === undefined, stale: false };
    s.at = Date.now();
  }
  if (!s) {
    const data = peek(path, params);
    s = {
      path, params, at: Date.now(),
      state: { data, error: null, loading: data === undefined, stale: false },
      listeners: new Set(), polls: new Map(), pollWatchers: new Set(),
      keepLast: true, inflight: null, again: false, seq: 0, ms: 0, timer: null, onVis: null,
    };
    /* mutate(): apply the same edit to what this store holds. A load already on
       the wire started before the edit, so its answer is dropped and one more
       pass follows. */
    watch(path, params, (fn) => {
      s.seq++;
      if (s.inflight) s.again = true;
      const d = s.state.data;
      if (d === undefined) return;
      const n = fn(d);
      if (n !== undefined) set(s, { data: share(d, n) });
    });
    stores.set(key, s);
  }
  return s;
}

/* Only a real change replaces the state (and re-renders the screens). */
function set(s, patch) {
  const prev = s.state;
  if (Object.keys(patch).every((k) => prev[k] === patch[k])) return;
  s.state = { ...prev, ...patch };
  if ("data" in patch) s.at = Date.now();
  for (const l of [...s.listeners]) l();
}

/* One load at a time (Odoo kpi_action refresh()/_doRefresh). A fresh request
   that arrives mid-load asks for ONE more pass after it, so nothing is lost;
   the answer in flight is then dropped, since a newer one follows. */
function load(s, fresh, ttl) {
  if (s.inflight) { if (fresh) s.again = true; return s.inflight; }
  s.inflight = (async () => {
    try {
      let f = fresh;
      do {
        s.again = false;
        const seq = ++s.seq;
        set(s, { loading: s.state.data === undefined, stale: false });
        try {
          const data = await read(s.path, s.params, { fresh: f, ttl });
          if (!s.again && s.seq === seq) { s.at = Date.now(); set(s, { data: share(s.state.data, data), error: null, loading: false, stale: false }); }
        } catch (error) {
          if (!s.again && s.seq === seq) {
            const had = s.state.data !== undefined;
            set(s, { data: s.keepLast ? s.state.data : undefined, error, loading: false, stale: had });
          }
        }
        f = true;
      } while (s.again);
    } finally {
      s.inflight = null;
    }
  })();
  return s.inflight;
}

/* The store polls at the shortest interval any mounted screen asked for. */
function repoll(s) {
  let ms = 0;
  for (const v of s.polls.values()) if (v > 0 && (!ms || v < ms)) ms = v;
  if (ms !== s.ms) {
    if (s.timer) clearInterval(s.timer);
    if (s.onVis) document.removeEventListener("visibilitychange", s.onVis);
    s.timer = null; s.onVis = null; s.ms = ms;
    if (ms) {
      const tick = () => { if (document.visibilityState === "visible") load(s, true); };
      const start = () => { if (s.timer) clearInterval(s.timer); s.timer = setInterval(tick, ms); };
      s.onVis = () => {
        if (document.visibilityState === "visible") { load(s, true); start(); }
        else { if (s.timer) clearInterval(s.timer); s.timer = null; }
      };
      start();
      document.addEventListener("visibilitychange", s.onVis);
    }
  }
  for (const l of [...s.pollWatchers]) l();
}

export function useResource(path, params = {}, { enabled = true, pollMs = 0, keepLast = true, ttl, deps = [] } = {}) {
  const key = stableKey(path, params ?? {});
  const s = storeFor(path, params ?? {}, key);
  const subscribe = useCallback((cb) => { s.listeners.add(cb); return () => { s.listeners.delete(cb); }; }, [s]);
  const state = useSyncExternalStore(subscribe, () => s.state, () => s.state);

  useEffect(() => {
    if (!enabled) return;
    s.keepLast = keepLast;
    load(s, false, ttl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, enabled, ttl, keepLast, ...deps]);

  useEffect(() => {
    if (!enabled || !pollMs) return;
    const token = {};
    s.polls.set(token, pollMs);
    repoll(s);
    return () => { s.polls.delete(token); repoll(s); };
  }, [s, enabled, pollMs]);

  const refresh = useCallback(() => (enabled ? load(s, true, ttl) : Promise.resolve()), [s, enabled, ttl]);
  return useMemo(() => ({ ...state, loading: enabled && state.loading, refresh }), [state, enabled, refresh]);
}

/* Whether some mounted screen is polling this read right now (TaskAlerts
   reads the board's copy when one is, instead of polling its own). */
export function useIsPolled(path, params = {}) {
  const s = storeFor(path, params ?? {}, stableKey(path, params ?? {}));
  const subscribe = useCallback((cb) => { s.pollWatchers.add(cb); return () => { s.pollWatchers.delete(cb); }; }, [s]);
  return useSyncExternalStore(subscribe, () => s.polls.size > 0, () => false);
}

/* A write: busy flag, last error, and a runner that invalidates reads.
     const { run, busy, error } = useAction();
     await run(() => startTask(id), { invalidate: "/kra_kpi/tasks" }); */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = useCallback(async (fn, { invalidate: prefix } = {}) => {
    setBusy(true); setError(null);
    try {
      const out = await fn();
      if (prefix !== undefined) invalidate(prefix);
      return out;
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);
  return { run, busy, error, clearError: () => setError(null) };
}
