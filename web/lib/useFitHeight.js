"use client";
/* Sizes an element to fill the window from where it starts down to the bottom
   (less `pad`), so a wide scroller's sideways bar sits on screen instead of
   after its tallest column. Re-fits when the window or the page above it
   changes size (a banner appearing, say). `ready` re-runs it once the element
   is actually rendered. */
import { useLayoutEffect } from "react";

export function useFitHeight(ref, { ready = true, min = 360, pad = 32 } = {}) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!ready || !el) return;
    let last = -1;
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      const h = Math.max(min, Math.round(window.innerHeight - top - pad));
      if (h !== last) { last = h; el.style.flex = "none"; el.style.height = `${h}px`; }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(document.body);
    window.addEventListener("resize", fit);
    return () => { ro.disconnect(); window.removeEventListener("resize", fit); el.style.height = ""; el.style.flex = ""; };
  }, [ref, ready, min, pad]);
}
