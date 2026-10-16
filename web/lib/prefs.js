"use client";
/* Per-browser, per-user conveniences (the mobile keeps these in AsyncStorage):
   board view, quick filters, sidebar collapsed, recently viewed. Every read and
   write is wrapped: storage can be blocked or full, and the page must still
   work without it. */
const NS = "kpi";

function key(name, uid) { return `${NS}.${name}:${uid ?? "me"}`; }

export function getPref(name, uid, fallback = null) {
  try {
    const raw = localStorage.getItem(key(name, uid));
    return raw == null ? fallback : JSON.parse(raw);
  } catch (_) { return fallback; }
}

export function setPref(name, uid, value) {
  try {
    if (value === undefined || value === null) localStorage.removeItem(key(name, uid));
    else localStorage.setItem(key(name, uid), JSON.stringify(value));
  } catch (_) {}
}

/* Recently viewed tasks (ids), newest first, at most 12. */
export function pushRecent(uid, taskId) {
  const list = (getPref("recent", uid, []) || []).filter((id) => id !== taskId);
  list.unshift(taskId);
  setPref("recent", uid, list.slice(0, 12));
}
