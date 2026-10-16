"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { read, peek, invalidate } from "./api";

/* A screen's read of one resource.

   useResource(path, params, { enabled, pollMs, keepLast, ttl, deps })
     → { data, error, loading, stale, refresh }

   Starts from what the app last knew (peek) so the screen draws at once,
   then refreshes. Polls pause while the tab is hidden. A failed refresh keeps
   the last data and reports `stale` instead of blanking the screen. */
export function useResource(path, params = {}, { enabled = true, pollMs = 0, keepLast = true, ttl, deps = [] } = {}) {
  const key = path + JSON.stringify(params ?? {});
  const [state, setState] = useState(() => ({ data: peek(path, params), error: null, loading: enabled && peek(path, params) === undefined, stale: false }));
  const alive = useRef(true);

  const load = useCallback(async (fresh) => {
    if (!enabled) return;
    setState((s) => ({ ...s, loading: s.data === undefined, stale: false }));
    try {
      const data = await read(path, params, { fresh, ttl });
      if (alive.current) setState({ data, error: null, loading: false, stale: false });
    } catch (error) {
      if (alive.current) setState((s) => ({ data: keepLast ? s.data : undefined, error, loading: false, stale: s.data !== undefined }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, ttl, ...deps]);

  useEffect(() => {
    alive.current = true;
    load(false);
    return () => { alive.current = false; };
  }, [load]);

  useEffect(() => {
    if (!enabled || !pollMs) return;
    let timer = null;
    const tick = () => { if (document.visibilityState === "visible") load(true); };
    const start = () => { stop(); timer = setInterval(tick, pollMs); };
    const stop = () => { if (timer) clearInterval(timer); timer = null; };
    const onVis = () => { if (document.visibilityState === "visible") { load(true); start(); } else stop(); };
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
  }, [enabled, pollMs, load]);

  const refresh = useCallback(() => load(true), [load]);
  return { ...state, refresh };
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
