"use client";
import { createContext, useContext } from "react";

/* The signed-in person, provided by components/shell/Gate.jsx from /api/auth/me:
   { uid, name, login, role: 'admin'|'developer'|'client', flags, mustChange }
   plus `refresh()` and `signOut()`. */
export const MeContext = createContext(null);

export function useMe() {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error("useMe() needs a <Gate> above it");
  return ctx;
}

export const isAdmin = (me) => me?.role === "admin";
export const isClient = (me) => me?.role === "client";

/* Initials for an avatar: "Arun Kumar" → "AK". */
export function initials(name = "") {
  const parts = String(name).trim().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || parts[0]?.[1] || "")).toUpperCase() || "?";
}

/* A stable colour per person, from the palette the design uses. */
const PALETTE = ["#6554C0", "#00875A", "#DE350B", "#FF8B00", "#0052CC", "#0891B2", "#7C3AED", "#16A34A", "#DB2777", "#D97706"];
export function avatarColor(seed) {
  const s = String(seed ?? "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
