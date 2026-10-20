"use client";
/* Everybody's profile photo, for every <Avatar uid={…}>: the top bar, the
   Dashboard cards and popup, boards, task cards, reports, settings lists…

   A photo is res.users.image_1920, set by the person on their Profile (or by
   an admin in Odoo). Odoo gives a user without one a generated initials SVG;
   that is not a photo, so our coloured initials show instead (same rule as
   services/more.js fetchMyPhoto).

   Requests are batched: every avatar that mounts in the same moment is asked
   for in ONE res.users read, and the answer is cached for the page's life, so
   a list of 30 people costs one call, not 30. Saving or removing a photo
   (PHOTO_EVENT) clears the cache and every avatar reloads. */
import { useEffect, useState } from "react";
import { callKw } from "@/lib/api";
import { PHOTO_EVENT } from "@/lib/services/more";

const cache = new Map();      /* uid → url | null */
const waiting = new Map();    /* uid → Set(setter) */
let queued = new Set();
let timer = null;

const generated = (b64) => /^(PD94|PHN2Zy)/.test(b64 || "");
const urlFor = (uid, version) => `/web/image/res.users/${uid}/avatar_128${version ? `?unique=${encodeURIComponent(version)}` : ""}`;

function flush() {
  timer = null;
  const ids = [...queued];
  queued = new Set();
  if (!ids.length) return;
  callKw("res.users", "read", [ids, ["image_128", "write_date"]], { context: { active_test: false } })
    .then((rows) => {
      const got = new Map((rows || []).map((r) => [r.id, r]));
      for (const id of ids) {
        const r = got.get(id);
        cache.set(id, r && r.image_128 && !generated(r.image_128) ? urlFor(id, r.write_date) : null);
      }
    })
    /* Not allowed to read someone (a client looking at staff) or offline:
       initials, and no retry storm. */
    .catch(() => { for (const id of ids) cache.set(id, null); })
    .finally(() => {
      for (const id of ids) for (const set of waiting.get(id) || []) set(cache.get(id));
    });
}

function want(uid) {
  queued.add(uid);
  if (!timer) timer = setTimeout(flush, 30);
}

if (typeof window !== "undefined") {
  window.addEventListener(PHOTO_EVENT, () => {
    const ids = [...cache.keys()];
    cache.clear();
    ids.forEach(want);
  });
}

/* The photo URL for a user id, or null (initials). */
export function usePhoto(uid) {
  const id = Number(uid) || 0;
  const [src, setSrc] = useState(() => (id && cache.has(id) ? cache.get(id) : null));
  useEffect(() => {
    if (!id) { setSrc(null); return undefined; }
    if (!waiting.has(id)) waiting.set(id, new Set());
    waiting.get(id).add(setSrc);
    if (cache.has(id)) setSrc(cache.get(id)); else want(id);
    return () => { waiting.get(id)?.delete(setSrc); };
  }, [id]);
  return src;
}
